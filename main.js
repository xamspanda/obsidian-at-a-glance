const { MarkdownRenderer, Notice, Plugin, requestUrl, moment } = require("obsidian");
const { spawn } = require("child_process");

const API_BASE_URL = "http://127.0.0.1:27124";
const HERMES_BIN = "/Users/Laura/.local/bin/hermes";
const DAILY_ROOT = "04 - Daily";
const DAYS_TO_SUMMARIZE = 7;
const OVERVIEW_HEADING = "AI Overview";

module.exports = class AIOverviewPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, await this.loadData());
    this.inFlight = new Set();
    this.generated = new Map();

    this.registerMarkdownCodeBlockProcessor("ai-overview", async (source, el, ctx) => {
      await this.processOverviewBlock(source, el, ctx);
    });
  }

  async processOverviewBlock(source, el, ctx) {
    const sourcePath = ctx.sourcePath;
    const today = this.getTodayInfo();
    const cacheKey = sourcePath || today.path;

    try {
      if (this.generated.has(cacheKey)) {
        await this.renderOverview(this.generated.get(cacheKey), el, sourcePath);
        return;
      }

      if (this.inFlight.has(cacheKey)) {
        this.renderLoading(el);
        return;
      }

      this.inFlight.add(cacheKey);
      this.renderLoading(el);

      const notes = await this.fetchPreviousDailyNotes(today.date);
      const prompt = this.buildHermesPrompt(notes, today);
      const hermesOutput = await this.runHermes(prompt);
      const overview = this.extractOverviewMarkdown(hermesOutput);

      if (!overview.startsWith("### AI Overview")) {
        console.warn("AI Overview: Hermes output did not start with the expected heading", overview);
      }

      this.generated.set(cacheKey, overview);
      await this.renderOverview(overview, el, sourcePath);
      await this.patchDailyNote(today.path, today.displayDate, overview);
    } catch (error) {
      this.handleProcessorError(error);
      this.renderError(el, error);
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  getToken() {
    const env = typeof process !== "undefined" ? process.env || {} : {};
    const settings = this.settings || {};
    return (
      // Actual Local REST API bearer token — update here or via env var
      "0c5d0de67d1b6ee69d366165790db04e2c5156a6e423c87b42726cca06bc5844" ||
      env.OBSIDIAN_LOCAL_REST_API_TOKEN ||
      env.OBSIDIAN_REST_API_TOKEN ||
      env.LOCAL_REST_API_TOKEN ||
      settings.localRestApiToken ||
      ""
    );
  }

  async apiRequest(method, path, body, extraHeaders = {}) {
    const token = this.getToken();
    if (!token) {
      throw new Error("Local REST API token is not configured");
    }

    try {
      return await requestUrl({
        url: `${API_BASE_URL}${path}`,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...extraHeaders,
        },
        body,
      });
    } catch (error) {
      const message = String(error && (error.message || error));
      if (message.includes("ECONNREFUSED") || message.includes("Failed to fetch") || message.includes("NetworkError")) {
        const unreachable = new Error("Local REST API not reachable");
        unreachable.code = "LOCAL_REST_UNREACHABLE";
        throw unreachable;
      }
      throw error;
    }
  }

  async listDailyFolder(folderPath) {
    const response = await this.apiRequest("GET", `/vault/${this.encodeVaultPath(folderPath)}/`);
    const parsed = this.parseJson(response.text);
    const entries = Array.isArray(parsed) ? parsed : parsed && (parsed.files || parsed.children);

    if (!Array.isArray(entries)) {
      return new Set();
    }

    return new Set(
      entries
        .map((entry) => (typeof entry === "string" ? entry : entry && (entry.name || entry.path)))
        .filter(Boolean)
        .map((entry) => entry.split("/").pop())
    );
  }

  async fetchPreviousDailyNotes(todayMoment) {
    const candidates = [];
    const folders = new Map();

    for (let offset = DAYS_TO_SUMMARIZE; offset >= 1; offset -= 1) {
      const day = todayMoment.clone().subtract(offset, "days");
      const path = this.getDailyNotePath(day);
      const folder = path.split("/").slice(0, -1).join("/");
      const fileName = path.split("/").pop();

      candidates.push({
        day,
        path,
        folder,
        fileName,
      });

      if (!folders.has(folder)) {
        folders.set(folder, null);
      }
    }

    for (const folder of folders.keys()) {
      try {
        folders.set(folder, await this.listDailyFolder(folder));
      } catch (error) {
        if (error && error.code === "LOCAL_REST_UNREACHABLE") {
          throw error;
        }

        console.warn(`AI Overview: could not list daily folder ${folder}`, error);
        folders.set(folder, new Set());
      }
    }

    const notes = [];
    for (const candidate of candidates) {
      const folderFiles = folders.get(candidate.folder);
      if (folderFiles.size > 0 && !folderFiles.has(candidate.fileName)) {
        continue;
      }

      try {
        const response = await this.apiRequest("GET", `/vault/${this.encodeVaultPath(candidate.path)}`);
        notes.push({
          date: candidate.day.format("YYYY-MM-DD"),
          dayName: candidate.day.format("dddd"),
          path: candidate.path,
          content: response.text || "",
        });
      } catch (error) {
        console.warn(`AI Overview: skipped unreadable daily note ${candidate.path}`, error);
      }
    }

    return notes;
  }

  buildHermesPrompt(notes, today) {
    const noteContext = notes
      .map((note) => `[Day: ${note.date} ${note.dayName}]\nPath: ${note.path}\n\n${note.content.trim()}`)
      .join("\n\n---\n\n");

    return `You are an AI Overview generator. Read the following 7 days of notes and produce a concise "AI Overview" section.

RULES:
- Output ONLY markdown starting with "### AI Overview"
- No preamble, no explanation, no JSON, no quotes
- Cover: tasks completed, active tasks, journal highlights, newly created notes, upcoming deadlines
- Be concise — bullet points, not paragraphs
- Add "*Generated by Hermes · [current time]*" as the last line

=== NOTES (oldest to newest) ===

${noteContext || "(No daily notes were found for the previous 7 calendar days.)"}

=== END NOTES ===

Today's date: ${today.isoDate}
Today is: ${today.displayDate}
Current time: ${today.time}`;
  }

  runHermes(prompt) {
    return new Promise((resolve, reject) => {
      const child = spawn(HERMES_BIN, ["chat", "-q", prompt], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("error", (error) => {
        error.code = "HERMES_ERROR";
        error.stderr = stderr;
        reject(error);
      });

      child.on("close", (code) => {
        if (code === 0) {
          resolve(stdout);
          return;
        }

        const error = new Error(`Hermes exited with code ${code}`);
        error.code = "HERMES_ERROR";
        error.stderr = stderr;
        reject(error);
      });
    });
  }

  extractOverviewMarkdown(output) {
    let markdown = String(output || "").trim();

    markdown = markdown.replace(/^```(?:markdown|md)?\s*/i, "").replace(/\s*```$/i, "").trim();

    const headingIndex = markdown.indexOf("### AI Overview");
    if (headingIndex >= 0) {
      markdown = markdown.slice(headingIndex).trim();
    }

    return markdown.replace(/\s*```$/i, "").trim();
  }

  async patchDailyNote(path, displayDate, overview) {
    await this.apiRequest(
      "PATCH",
      `/vault/${this.encodeVaultPath(path)}`,
      JSON.stringify({ data: overview }),
      {
        "Content-Type": "application/json",
        "Target-Type": `DAILY NOTE::${displayDate}::${OVERVIEW_HEADING}`,
      }
    );
  }

  renderLoading(el) {
    el.empty();
    const container = el.createDiv({ cls: "ai-overview ai-overview-loading" });
    container.setText("Generating AI Overview with Hermes...");
  }

  renderError(el, error) {
    el.empty();
    const container = el.createDiv({ cls: "ai-overview ai-overview-error" });
    container.setText(`AI Overview failed: ${error.message || error}`);
  }

  async renderOverview(markdown, el, sourcePath) {
    el.empty();
    const container = el.createDiv({ cls: "ai-overview" });
    await MarkdownRenderer.render(this.app, markdown, container, sourcePath || "", this);
  }

  handleProcessorError(error) {
    if (error && error.code === "LOCAL_REST_UNREACHABLE") {
      new Notice("AI Overview: Local REST API not reachable");
      return;
    }

    if (error && error.code === "HERMES_ERROR") {
      console.error("AI Overview: Hermes error", error, error.stderr || "");
      new Notice("AI Overview: Hermes error — see console");
      return;
    }

    console.error("AI Overview: processor error", error);
    new Notice("AI Overview: error — see console");
  }

  getTodayInfo() {
    const date = moment();
    return {
      date,
      isoDate: date.format("YYYY-MM-DD"),
      displayDate: date.format("dddd, MMMM D, YYYY"),
      path: this.getDailyNotePath(date),
      time: date.format("HH:mm"),
    };
  }

  getDailyNotePath(date) {
    const year = date.format("YYYY");
    const monthFolder = date.format("MM-MMMM");
    const fileName = `${date.format("YYYY-MM-DD")}-${date.format("dddd")}.md`;
    return `${DAILY_ROOT}/${year}/${monthFolder}/${fileName}`;
  }

  encodeVaultPath(path) {
    return path
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
  }

  parseJson(text) {
    try {
      return JSON.parse(text);
    } catch (_error) {
      return null;
    }
  }
};
