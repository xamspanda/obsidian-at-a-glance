const { MarkdownRenderer, Notice, Plugin, PluginSettingTab, Setting, requestUrl, moment } = require("obsidian");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const API_BASE_URL = "https://127.0.0.1:27124";
const HERMES_BIN = "/Users/Laura/.local/bin/hermes";
const DAILY_ROOT = "04 - Daily";
const DAYS_TO_SUMMARIZE = 7;

const DEFAULT_SETTINGS = {
  hermesBin: HERMES_BIN,
  hermesModel: "openai/gpt-5.4-mini",
  hermesProvider: "openrouter",
  dailyRoot: DAILY_ROOT,
  daysToSummarize: DAYS_TO_SUMMARIZE,
  maxCrawlFiles: 40,
  logFullPrompt: false,
  persistOverviewToNote: false,
};

class AtAGlancePlugin extends Plugin {
  static DEFAULT_SETTINGS = DEFAULT_SETTINGS;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.inFlight = new Map();
    this.generated = new Map();
    this.renderedBlocks = new Map();
    this.spawnProcess = spawn;

    this.addSettingTab(new AtAGlanceSettingTab(this.app, this));

    this.addCommand({
      id: "regenerate-current-note-at-a-glance",
      name: "Regenerate At a Glance for current note",
      callback: async () => {
        await this.regenerateCurrentNoteOverview();
      },
    });

    this.registerMarkdownCodeBlockProcessor("glance", async (_source, el, ctx) => {
      await this.processOverviewBlock(el, ctx);
    });

    await this.log("info", "At a Glance plugin loaded", {
      model: this.settings.hermesModel,
      provider: this.settings.hermesProvider,
      maxCrawlFiles: this.settings.maxCrawlFiles,
      persistOverviewToNote: this.settings.persistOverviewToNote,
    });
  }

  async processOverviewBlock(el, ctx) {
    const sourcePath = ctx.sourcePath || this.getTodayInfo().path;
    const targetDay = this.getDayInfoForPath(sourcePath);
    const cacheKey = sourcePath;
    this.registerRenderedBlock(cacheKey, el, sourcePath);

    try {
      if (this.generated.has(cacheKey)) {
        await this.renderOverview(this.generated.get(cacheKey), el, sourcePath);
        return;
      }

      if (this.inFlight.has(cacheKey)) {
        this.renderLoading(el);
        this.inFlight.get(cacheKey)
          .then((overview) => this.renderOverview(overview, el, sourcePath))
          .catch((error) => this.renderError(el, error));
        return;
      }

      this.renderLoading(el);
      const generation = this.generateOverviewForPath(sourcePath, targetDay)
        .then(async (overview) => {
          this.generated.set(cacheKey, overview);
          await this.renderOverviewInRegisteredBlocks(cacheKey, overview);
          return overview;
        })
        .catch(async (error) => {
          await this.renderErrorInRegisteredBlocks(cacheKey, error);
          throw error;
        })
        .finally(() => {
          this.inFlight.delete(cacheKey);
        });

      this.inFlight.set(cacheKey, generation);
      await generation;
    } catch (error) {
      this.handleProcessorError(error);
      this.renderError(el, error);
    }
  }

  async generateOverviewForPath(sourcePath, targetDay = this.getDayInfoForPath(sourcePath)) {
    const notes = await this.fetchRecentDailyNotes(targetDay.date);
    const prompt = this.buildHermesPrompt(notes, targetDay, sourcePath);
    const hermesOutput = await this.runHermes(prompt);
    const overview = this.extractOverviewMarkdown(hermesOutput);
    await this.updateOverviewCodeblockStatus(sourcePath, overview);

    if (this.settings.persistOverviewToNote) {
      await this.patchDailyNote(sourcePath, overview);
    }

    return overview;
  }

  async regenerateCurrentNoteOverview() {
    try {
      const file = this.app.workspace.getActiveFile();
      if (!file || file.extension !== "md") {
        new Notice("At a Glance: open a markdown note first");
        return;
      }

      this.generated.delete(file.path);
      await this.log("info", "Manual regenerate requested", { path: file.path });
      await this.renderLoadingInRegisteredBlocks(file.path);
      const generation = this.generateOverviewForPath(file.path)
        .then(async (overview) => {
          this.generated.set(file.path, overview);
          await this.renderOverviewInRegisteredBlocks(file.path, overview);
          return overview;
        })
        .catch(async (error) => {
          await this.renderErrorInRegisteredBlocks(file.path, error);
          throw error;
        })
        .finally(() => {
          this.inFlight.delete(file.path);
        });
      this.inFlight.set(file.path, generation);
      await generation;

      if (this.app.workspace.trigger) {
        this.app.workspace.trigger("layout-change");
      }

      new Notice("At a Glance regenerated.");
    } catch (error) {
      this.handleProcessorError(error);
      new Notice("At a Glance: regenerate failed — see log");
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  getToken() {
    const env = typeof process !== "undefined" ? process.env || {} : {};
    const settings = this.settings || {};
    return (
      env.OBSIDIAN_LOCAL_REST_API_TOKEN ||
      env.OBSIDIAN_REST_API_TOKEN ||
      env.LOCAL_REST_API_TOKEN ||
      settings.localRestApiToken ||
      ""
    );
  }

  async apiRequest(method, vaultPath, body, extraHeaders = {}) {
    const token = this.getToken();
    if (!token) {
      throw new Error("Local REST API token is not configured");
    }

    try {
      await this.log("debug", "Local REST API request", { method, path: vaultPath });
      return await requestUrl({
        url: `${API_BASE_URL}${vaultPath}`,
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
    const absoluteFolder = path.join(this.getVaultPath(), folderPath);
    if (fs.existsSync(absoluteFolder)) {
      return new Set(fs.readdirSync(absoluteFolder, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name));
    }

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

  async fetchRecentDailyNotes(targetMoment) {
    const candidates = [];
    const folders = new Map();
    const daysToSummarize = Number(this.settings.daysToSummarize || DAYS_TO_SUMMARIZE);

    for (let offset = daysToSummarize - 1; offset >= 0; offset -= 1) {
      const day = targetMoment.clone().subtract(offset, "days");
      const notePath = this.getDailyNotePath(day);
      const folder = notePath.split("/").slice(0, -1).join("/");
      const fileName = notePath.split("/").pop();

      candidates.push({
        day,
        path: notePath,
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

        await this.log("warn", "Could not list daily folder", { folder, error: this.formatError(error) });
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
        let content = "";
        const absolutePath = path.join(this.getVaultPath(), candidate.path);
        if (fs.existsSync(absolutePath)) {
          content = fs.readFileSync(absolutePath, "utf8");
        } else {
          const response = await this.apiRequest("GET", `/vault/${this.encodeVaultPath(candidate.path)}`);
          content = response.text || "";
        }

        notes.push({
          date: candidate.day.format("YYYY-MM-DD"),
          dayName: candidate.day.format("dddd"),
          path: candidate.path,
          content,
          tasksCodeblocks: this.extractTasksCodeblocks(content),
          taskLines: this.extractCheckboxTasks(content, candidate.path),
        });
      } catch (error) {
        await this.log("warn", "Skipped unreadable daily note", { path: candidate.path, error: this.formatError(error) });
      }
    }

    await this.log("info", "Fetched recent daily notes", {
      requestedDays: daysToSummarize,
      notesFound: notes.length,
      vaultPath: this.getVaultPath(),
      paths: notes.map((note) => note.path),
      taskCodeblockCount: notes.reduce((count, note) => count + (note.tasksCodeblocks || []).length, 0),
      taskLineCount: notes.reduce((count, note) => count + (note.taskLines || []).length, 0),
    });

    return notes;
  }

  buildHermesPrompt(notes, targetDay, sourcePath) {
    const noteContext = notes
      .map((note) => `[Day: ${note.date} ${note.dayName}]\nPath: ${note.path}\n\n${note.content.trim()}`)
      .join("\n\n---\n\n");

    const tasksCodeblockContext = notes
      .flatMap((note) => (note.tasksCodeblocks || []).map((block, index) => `[${note.date} ${note.path} tasks block ${index + 1}]\n${block.trim()}`))
      .join("\n\n---\n\n");
    const taskLineContext = notes
      .flatMap((note) => note.taskLines || this.extractCheckboxTasks(note.content || "", note.path))
      .slice(0, 200)
      .map((task) => `${task.status === "x" ? "DONE" : "TODO"} ${task.path}:${task.line} ${task.text}`)
      .join("\n");

    const vaultPath = this.getVaultPath();
    const seedPaths = notes.map((note) => `- ${note.path}`).join("\n") || "- (No seed daily notes found)";
    const maxCrawlFiles = Number(this.settings.maxCrawlFiles || DEFAULT_SETTINGS.maxCrawlFiles);

    return `You are an At a Glance generator running inside Hermes for Laura's Obsidian vault. Use the recent daily notes below as seed context, then use your available file/search tools to crawl the vault yourself for linked context before summarizing.

Vault root: ${vaultPath}
Current note: ${sourcePath || "(unknown)"}
Seed daily-note paths:
${seedPaths}

CRAWL INSTRUCTIONS:
- Walk wikilinks from the seed daily notes to understand current goals, classes, projects, tasks, and deadlines.
- Treat the explicit Tasks Plugin Codeblocks and Scanned Vault Task Lines sections below as high-priority task context. The codeblocks are Tasks plugin queries from the daily notes; infer what task slice the user intended to see, then use scanned checkbox tasks and linked-note crawl to summarize the actual task state.
- You may decide crawl depth dynamically, but inspect a hard maximum of ${maxCrawlFiles} markdown files total, including seed notes.
- Stay inside the vault root. Do not modify files.
- Use Laura's existing Hermes/Honcho memory when it helps interpret goals or ongoing work.
- Prefer directly linked notes and recently relevant notes over broad vault search.

Priority order:
1. tasks/due dates, including Obsidian checkbox tasks and due-date emoji/metadata
2. daily-note links
3. project/research/idea tags such as #project, #research, and #idea
4. recently modified linked notes
5. journal references

Read the following ${this.settings.daysToSummarize} days of notes and produce concise markdown designed to render inside the existing daily-note \`### At a Glance\` section.

RULES:
- Output ONLY the generated markdown body; no preamble, no explanation, no JSON, no quotes
- Do not include an "At a Glance" heading. The user controls the surrounding heading in the daily note template.
- Do not put the words "At a Glance" at the top of the response, with or without markdown heading markers.
- Use the response template below exactly: keep the section labels, order, and generated footer consistent across runs.
- Use short bullet points under each label. If a section has nothing useful, write "- None surfaced." rather than omitting the section.
- Do not duplicate the same item across multiple sections unless it genuinely belongs in both places.
- Add "*Generated by Hermes · [current time]*" as the last line, replacing [current time] with the current time provided below.

RESPONSE TEMPLATE:
**Completed:**
- ...

**Active / overdue tasks:**
- ...

**Upcoming deadlines:**
- ...

**Journal / project highlights:**
- ...

**Newly created / updated notes:**
- ...

**Current goals:**
- ...

*Generated by Hermes · [current time]*

=== NOTES (oldest to newest) ===

${noteContext || "(No daily notes were found for the configured calendar window.)"}

=== END NOTES ===

=== TASKS PLUGIN CODEBLOCKS FROM SEED DAILY NOTES ===

${tasksCodeblockContext || "(No ```tasks codeblocks were found in the seed daily notes.)"}

=== END TASKS PLUGIN CODEBLOCKS ===

=== SCANNED VAULT TASK LINES FROM SEED DAILY NOTES ===

${taskLineContext || "(No Obsidian checkbox task lines were found in the seed daily notes.)"}

=== END SCANNED VAULT TASK LINES ===

Target note date: ${targetDay.isoDate}
Target note display date: ${targetDay.displayDate}
Current time: ${targetDay.time}`;
  }

  extractTasksCodeblocks(content) {
    const blocks = [];
    const regex = /```tasks\s*\n([\s\S]*?)```/gi;
    let match;
    while ((match = regex.exec(String(content || ""))) !== null) {
      blocks.push(match[1].trim());
    }
    return blocks;
  }

  extractCheckboxTasks(content, notePath = "") {
    return String(content || "")
      .split(/\r?\n/)
      .map((line, index) => {
        const match = line.match(/^\s*>?\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
        if (!match) return null;
        return {
          path: notePath,
          line: index + 1,
          status: match[1].toLowerCase(),
          text: match[2].trim(),
        };
      })
      .filter(Boolean);
  }

  runHermes(prompt) {
    return new Promise((resolve, reject) => {
      const args = [
        "-m",
        this.settings.hermesModel || DEFAULT_SETTINGS.hermesModel,
        "--provider",
        this.settings.hermesProvider || DEFAULT_SETTINGS.hermesProvider,
        "-z",
        prompt,
      ];

      this.log("info", "Starting Hermes", {
        model: args[1],
        provider: args[3],
        promptChars: prompt.length,
        prompt: this.settings.logFullPrompt ? prompt : undefined,
      });

      // Use -z (oneshot mode) for clean output: no reasoning block,
      // no session_id line, no banner — just the final text response.
      const child = this.spawnProcess(this.settings.hermesBin || HERMES_BIN, args, {
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
          this.log("info", "Hermes completed", { stdoutChars: stdout.length, stderrChars: stderr.length });
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

    markdown = this.stripDuplicateOverviewHeading(markdown);

    return markdown.replace(/\s*```$/i, "").trim();
  }

  stripDuplicateOverviewHeading(markdown) {
    let cleaned = String(markdown || "").trim();

    for (let i = 0; i < 3; i += 1) {
      const before = cleaned;
      cleaned = cleaned
        .replace(/^\s*(?:#{1,6}\s*)?(?:\*\*|__)?At a Glance(?:\*\*|__)?\s*:?[\t ]*(?:\r?\n|$)/i, "")
        .replace(/^\s*<h[1-6][^>]*>\s*At a Glance\s*<\/h[1-6]>\s*/i, "")
        .trim();

      if (cleaned === before) {
        break;
      }
    }

    return cleaned;
  }

  getGeneratedAtLabel(overview) {
    const match = String(overview || "").match(/Generated by Hermes\s*·\s*([^*\n]+)/i);
    if (match) {
      return match[1].trim();
    }

    const now = new Date();
    const parts = new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "short",
    }).formatToParts(now).reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});

    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${parts.timeZoneName || ""}`.trim();
  }

  async updateOverviewCodeblockStatus(notePath, overview) {
    const generatedAt = this.getGeneratedAtLabel(overview);
    const status = `*Overview generated by Hermes on ${generatedAt}*`;
    const absolutePath = path.join(this.getVaultPath(), notePath);

    if (!fs.existsSync(absolutePath)) {
      await this.log("warn", "Could not update glance codeblock status because note file was not found", { path: notePath });
      return;
    }

    const original = fs.readFileSync(absolutePath, "utf8");
    const codeblockPattern = new RegExp("(```glance[^\\n]*\\n)([\\s\\S]*?)(\\n?```)", "i");
    if (!codeblockPattern.test(original)) {
      await this.log("warn", "Could not update glance codeblock status because no glance block was found", { path: notePath });
      return;
    }

    const updated = original.replace(codeblockPattern, (_match, opening, _body, closing) => `${opening}${status}\n${closing.replace(/^\r?\n/, "")}`);
    if (updated === original) {
      return;
    }

    fs.writeFileSync(absolutePath, updated, "utf8");
    await this.log("info", "Updated glance codeblock status", { path: notePath, generatedAt });
  }

  async patchDailyNote(notePath, overview) {
    await this.apiRequest(
      "PATCH",
      `/vault/${this.encodeVaultPath(notePath)}`,
      overview,
      {
        "Content-Type": "text/markdown",
        "Operation": "prepend",
        "Target-Type": "heading",
        "Target": "DAILY NOTE::At a Glance",
        "Create-Target-If-Missing": "true",
      }
    );
  }

  renderLoading(el) {
    el.empty();
    const container = el.createDiv({ cls: "at-a-glance at-a-glance-loading" });
    container.setText("Generating At a Glance with Hermes...");
  }

  registerRenderedBlock(cacheKey, el, sourcePath) {
    if (!this.renderedBlocks) {
      this.renderedBlocks = new Map();
    }
    if (!this.renderedBlocks.has(cacheKey)) {
      this.renderedBlocks.set(cacheKey, new Set());
    }
    this.renderedBlocks.get(cacheKey).add({ el, sourcePath });
  }

  async renderLoadingInRegisteredBlocks(cacheKey) {
    const blocks = Array.from((this.renderedBlocks && this.renderedBlocks.get(cacheKey)) || []);
    await Promise.all(blocks.map(async ({ el }) => this.renderLoading(el)));
  }

  async renderOverviewInRegisteredBlocks(cacheKey, overview) {
    const blocks = Array.from((this.renderedBlocks && this.renderedBlocks.get(cacheKey)) || []);
    await Promise.all(blocks.map(async ({ el, sourcePath }) => this.renderOverview(overview, el, sourcePath)));
  }

  async renderErrorInRegisteredBlocks(cacheKey, error) {
    const blocks = Array.from((this.renderedBlocks && this.renderedBlocks.get(cacheKey)) || []);
    await Promise.all(blocks.map(async ({ el }) => this.renderError(el, error)));
  }

  renderError(el, error) {
    el.empty();
    const container = el.createDiv({ cls: "at-a-glance at-a-glance-error" });
    container.setText(`At a Glance failed: ${error.message || error}`);
  }

  async renderOverview(markdown, el, sourcePath) {
    el.empty();
    const container = el.createDiv({ cls: "at-a-glance" });
    await MarkdownRenderer.render(this.app, markdown, container, sourcePath || "", this);
  }

  handleProcessorError(error) {
    if (error && error.code === "LOCAL_REST_UNREACHABLE") {
      this.log("error", "Local REST API not reachable", { error: this.formatError(error) });
      new Notice("At a Glance: Local REST API not reachable");
      return;
    }

    if (error && error.code === "HERMES_ERROR") {
      this.log("error", "Hermes error", { error: this.formatError(error), stderr: error.stderr || "" });
      new Notice("At a Glance: Hermes error — see log");
      return;
    }

    this.log("error", "Processor error", { error: this.formatError(error) });
    new Notice("At a Glance: error — see log");
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

  getDayInfoForPath(notePath) {
    const match = String(notePath || "").match(/(\d{4}-\d{2}-\d{2})-[^/]+\.md$/);
    const date = match ? moment(match[1], "YYYY-MM-DD") : moment();
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
    return `${this.settings.dailyRoot || DAILY_ROOT}/${year}/${monthFolder}/${fileName}`;
  }

  getVaultPath() {
    const adapter = this.app && this.app.vault && this.app.vault.adapter;
    if (adapter && typeof adapter.getBasePath === "function") {
      return adapter.getBasePath();
    }
    return "/Users/Laura/Obsidian/Primary-Vault";
  }

  getLogPath() {
    return path.join(this.getVaultPath(), ".obsidian", "plugins", "obsidian-at-a-glance", "glance.log");
  }

  async log(level, message, details = {}) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      message,
      ...details,
    };

    try {
      const logPath = this.getLogPath();
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
    } catch (error) {
      console.error("At a Glance: failed to write log", error, entry);
    }
  }

  formatError(error) {
    if (!error) return null;
    return {
      message: error.message || String(error),
      code: error.code,
      stack: error.stack,
    };
  }

  encodeVaultPath(vaultPath) {
    return vaultPath
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
}

class AtAGlanceSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    if (!containerEl || !Setting) return;

    containerEl.empty();
    containerEl.createEl("h2", { text: "At a Glance" });

    new Setting(containerEl)
      .setName("Hermes binary")
      .setDesc("Path to the Hermes CLI binary.")
      .addText((text) => text
        .setValue(this.plugin.settings.hermesBin)
        .onChange(async (value) => {
          this.plugin.settings.hermesBin = value || DEFAULT_SETTINGS.hermesBin;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Hermes model")
      .setDesc("Model used for At a Glance generation.")
      .addText((text) => text
        .setValue(this.plugin.settings.hermesModel)
        .onChange(async (value) => {
          this.plugin.settings.hermesModel = value || DEFAULT_SETTINGS.hermesModel;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Hermes provider")
      .setDesc("Provider used with Hermes. Default: openrouter.")
      .addText((text) => text
        .setValue(this.plugin.settings.hermesProvider)
        .onChange(async (value) => {
          this.plugin.settings.hermesProvider = value || DEFAULT_SETTINGS.hermesProvider;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Days to summarize")
      .setDesc("Number of recent daily notes to seed into Hermes.")
      .addText((text) => text
        .setPlaceholder("7")
        .setValue(String(this.plugin.settings.daysToSummarize))
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          this.plugin.settings.daysToSummarize = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SETTINGS.daysToSummarize;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Maximum crawl files")
      .setDesc("Hard maximum number of markdown files Hermes should inspect while crawling linked notes.")
      .addText((text) => text
        .setPlaceholder("40")
        .setValue(String(this.plugin.settings.maxCrawlFiles))
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          this.plugin.settings.maxCrawlFiles = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SETTINGS.maxCrawlFiles;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("Log full prompt")
      .setDesc("Debug mode: include the full Hermes prompt in glance.log. This can include private journal content.")
      .addToggle((toggle) => toggle
        .setValue(Boolean(this.plugin.settings.logFullPrompt))
        .onChange(async (value) => {
          this.plugin.settings.logFullPrompt = value;
          await this.plugin.saveSettings();
        }));
  }
}

module.exports = AtAGlancePlugin;
