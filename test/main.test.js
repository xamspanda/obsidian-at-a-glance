const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "obsidian") {
    class Plugin {
      constructor() {
        this.app = null;
      }
      addCommand(command) {
        this._commands = this._commands || [];
        this._commands.push(command);
      }
      addSettingTab(tab) {
        this._settingTab = tab;
      }
      registerMarkdownCodeBlockProcessor(type, callback) {
        this._processor = { type, callback };
      }
      async loadData() {
        return {};
      }
      async saveData(data) {
        this._savedData = data;
      }
    }
    class PluginSettingTab {}
    class Setting {}
    return {
      MarkdownRenderer: { render: async (_app, markdown, container) => { container.renderedMarkdown = markdown; } },
      Notice: class Notice {},
      Plugin,
      PluginSettingTab,
      Setting,
      requestUrl: async () => ({ text: "" }),
      moment: () => ({
        clone() { return this; },
        subtract() { return this; },
        format() { return "2026-04-27"; },
      }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const AtAGlancePlugin = require("../main.js");

function makePlugin(vaultPath = "/Users/Laura/Obsidian/Primary-Vault") {
  const plugin = new AtAGlancePlugin();
  plugin.app = {
    vault: {
      adapter: {
        getBasePath: () => vaultPath,
      },
    },
    workspace: {
      getActiveFile: () => ({ path: "04 - Daily/2026/04-April/2026-04-27-Monday.md", extension: "md" }),
    },
  };
  plugin.settings = Object.assign({}, AtAGlancePlugin.DEFAULT_SETTINGS);
  plugin.log = async () => {};
  return plugin;
}

function makeMoment(isoDate) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  return {
    clone() {
      return makeMoment(date.toISOString().slice(0, 10));
    },
    subtract(amount, unit) {
      if (unit !== "days") throw new Error(`Unexpected unit: ${unit}`);
      date.setUTCDate(date.getUTCDate() - amount);
      return this;
    },
    format(formatString) {
      const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      const yyyy = String(date.getUTCFullYear());
      const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(date.getUTCDate()).padStart(2, "0");
      const dddd = weekdays[date.getUTCDay()];
      const mmmm = months[date.getUTCMonth()];
      return {
        YYYY: yyyy,
        "MM-MMMM": `${mm}-${mmmm}`,
        "YYYY-MM-DD": `${yyyy}-${mm}-${dd}`,
        dddd,
      }[formatString] || `${yyyy}-${mm}-${dd}`;
    },
  };
}

function makeElement() {
  return {
    children: [],
    empty() {
      this.children = [];
    },
    createDiv({ cls } = {}) {
      const child = {
        cls,
        text: "",
        renderedMarkdown: "",
        setText(value) {
          this.text = value;
        },
      };
      this.children.push(child);
      return child;
    },
  };
}

test("default settings expose bounded Hermes vault crawl configuration", () => {
  assert.equal(AtAGlancePlugin.DEFAULT_SETTINGS.maxCrawlFiles, 40);
  assert.equal(AtAGlancePlugin.DEFAULT_SETTINGS.logFullPrompt, false);
  assert.equal(AtAGlancePlugin.DEFAULT_SETTINGS.hermesModel, "openai/gpt-5.4-mini");
  assert.equal(AtAGlancePlugin.DEFAULT_SETTINGS.hermesProvider, "openrouter");
  assert.equal(AtAGlancePlugin.DEFAULT_SETTINGS.persistOverviewToNote, false);
});

test("Hermes prompt passes vault path and asks Hermes to crawl linked notes with bounded priority order", () => {
  const plugin = makePlugin();
  const notes = [
    {
      date: "2026-04-27",
      dayName: "Monday",
      path: "04 - Daily/2026/04-April/2026-04-27-Monday.md",
      content: "- [[Task 1]]\n- [ ] Finish project 📅 2026-04-28",
    },
  ];
  const today = { isoDate: "2026-04-27", displayDate: "Monday, April 27, 2026", time: "17:30" };

  const prompt = plugin.buildHermesPrompt(notes, today, "04 - Daily/2026/04-April/2026-04-27-Monday.md");

  assert.match(prompt, /Vault root: \/Users\/Laura\/Obsidian\/Primary-Vault/);
  assert.match(prompt, /Seed daily-note paths/);
  assert.match(prompt, /hard maximum of 40 markdown files/i);
  assert.match(prompt, /Priority order/);
  assert.match(prompt, /tasks\/due dates/i);
  assert.match(prompt, /daily-note links/i);
  assert.match(prompt, /project\/research\/idea tags/i);
  assert.match(prompt, /recently modified linked notes/i);
  assert.match(prompt, /journal references/i);
});

test("onload registers codeblock processor, settings tab, and current-note regenerate command", async () => {
  const plugin = makePlugin();
  await plugin.onload();

  assert.equal(plugin._processor.type, "glance");
  assert.ok(plugin._settingTab);
  assert.ok(plugin._commands.some((command) => command.id === "regenerate-current-note-at-a-glance"));
});

test("Hermes invocation pins configured OpenRouter model while preserving default profile memory", async () => {
  const plugin = makePlugin();
  let observed;
  plugin.spawnProcess = (bin, args, options) => {
    observed = { bin, args, options };
    return {
      stdout: { on: (event, callback) => event === "data" && callback(Buffer.from("### At a Glance\n")) },
      stderr: { on: () => {} },
      on: (event, callback) => event === "close" && callback(0),
    };
  };

  const output = await plugin.runHermes("prompt");

  assert.equal(output, "### At a Glance\n");
  assert.equal(observed.bin, "/Users/Laura/.local/bin/hermes");
  assert.deepEqual(observed.args, ["-m", "openai/gpt-5.4-mini", "--provider", "openrouter", "-z", "prompt"]);
});

test("recent daily notes are read directly from the local vault filesystem", async () => {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "glance-vault-"));
  const dailyDir = path.join(vaultPath, "04 - Daily", "2026", "04-April");
  fs.mkdirSync(dailyDir, { recursive: true });
  fs.writeFileSync(path.join(dailyDir, "2026-04-27-Monday.md"), "# Daily\n- [[Goal Note]]\n", "utf8");

  const plugin = makePlugin(vaultPath);
  plugin.settings.daysToSummarize = 1;
  plugin.apiRequest = async () => {
    throw new Error("Local REST API should not be used for local seed-note reads");
  };
  const targetMoment = makeMoment("2026-04-27");

  const notes = await plugin.fetchRecentDailyNotes(targetMoment);

  assert.equal(notes.length, 1);
  assert.equal(notes[0].path, "04 - Daily/2026/04-April/2026-04-27-Monday.md");
  assert.match(notes[0].content, /\[\[Goal Note\]\]/);
});

test("recent daily notes includes sparse existing notes across the configured seven-day window", async () => {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "glance-vault-"));
  const dailyDir = path.join(vaultPath, "04 - Daily", "2026", "04-April");
  fs.mkdirSync(dailyDir, { recursive: true });
  fs.writeFileSync(path.join(dailyDir, "2026-04-22-Wednesday.md"), "# Wednesday\n- [[Linear Algebra]]\n", "utf8");
  fs.writeFileSync(path.join(dailyDir, "2026-04-24-Friday.md"), "# Friday\n- [[Architecture]]\n", "utf8");
  fs.writeFileSync(path.join(dailyDir, "2026-04-26-Sunday.md"), "# Sunday\n- [[Networks]]\n", "utf8");
  fs.writeFileSync(path.join(dailyDir, "2026-04-27-Monday.md"), "# Monday\n- [[Python Homework]]\n", "utf8");

  const plugin = makePlugin(vaultPath);
  plugin.settings.daysToSummarize = 7;
  plugin.apiRequest = async () => {
    throw new Error("Local REST API should not be used for local seed-note reads");
  };

  const notes = await plugin.fetchRecentDailyNotes(makeMoment("2026-04-27"));

  assert.deepEqual(notes.map((note) => note.date), ["2026-04-22", "2026-04-24", "2026-04-26", "2026-04-27"]);
  assert.match(notes.map((note) => note.content).join("\n"), /Linear Algebra/);
  assert.match(notes.map((note) => note.content).join("\n"), /Networks/);
});

test("Hermes prompt includes tasks codeblocks and scanned vault task lines as explicit task context", () => {
  const plugin = makePlugin();
  const notes = [
    {
      date: "2026-04-27",
      dayName: "Monday",
      path: "04 - Daily/2026/04-April/2026-04-27-Monday.md",
      content: "```tasks\nnot done\ndue before tomorrow\n```\n- [ ] Fix Task 1 📅 2026-04-27\n",
      tasksCodeblocks: ["not done\ndue before tomorrow"],
    },
  ];
  const today = { isoDate: "2026-04-27", displayDate: "Monday, April 27, 2026", time: "17:30" };

  const prompt = plugin.buildHermesPrompt(notes, today, "04 - Daily/2026/04-April/2026-04-27-Monday.md");

  assert.match(prompt, /TASKS PLUGIN CODEBLOCKS/i);
  assert.match(prompt, /not done/);
  assert.match(prompt, /due before tomorrow/);
  assert.match(prompt, /SCANNED VAULT TASK LINES/i);
  assert.match(prompt, /Fix Task 1/);
});

test("Hermes prompt omits the At a Glance heading requirement and includes a stable response template", () => {
  const plugin = makePlugin();
  const notes = [
    {
      date: "2026-04-27",
      dayName: "Monday",
      path: "04 - Daily/2026/04-April/2026-04-27-Monday.md",
      content: "### At a Glance\n```glance\n```\n### Tasks\n- [ ] Finish [[Task 1]] 📅 2026-04-28",
    },
  ];
  const today = { isoDate: "2026-04-27", displayDate: "Monday, April 27, 2026", time: "17:30" };

  const prompt = plugin.buildHermesPrompt(notes, today, "04 - Daily/2026/04-April/2026-04-27-Monday.md");

  assert.doesNotMatch(prompt, /Output ONLY markdown starting with "### At a Glance"/);
  assert.doesNotMatch(prompt, /starting with "### At a Glance"/);
  assert.match(prompt, /Do not include an "At a Glance" heading/i);
  assert.match(prompt, /RESPONSE TEMPLATE/i);
  assert.match(prompt, /\*\*Completed:\*\*/);
  assert.match(prompt, /\*\*Active \/ overdue tasks:\*\*/);
  assert.match(prompt, /\*\*Upcoming deadlines:\*\*/);
  assert.match(prompt, /\*Generated by Hermes · \[current time\]\*/);
});

test("extractOverviewMarkdown strips accidental At a Glance headings from Hermes output", () => {
  const plugin = makePlugin();

  assert.equal(plugin.extractOverviewMarkdown("### At a Glance\n\n**Completed:**\n- Done"), "**Completed:**\n- Done");
  assert.equal(plugin.extractOverviewMarkdown("At a Glance\n**Completed:**\n- Done"), "**Completed:**\n- Done");
  assert.equal(plugin.extractOverviewMarkdown("At a Glance\nCompleted:\n- Done"), "Completed:\n- Done");
  assert.equal(plugin.extractOverviewMarkdown("At a Glance\n\nCompleted:\n- Done"), "Completed:\n- Done");
  assert.equal(plugin.extractOverviewMarkdown("**At a Glance**\n\nCompleted:\n- Done"), "Completed:\n- Done");
  assert.equal(plugin.extractOverviewMarkdown("At a Glance:\n\nCompleted:\n- Done"), "Completed:\n- Done");
  assert.equal(plugin.extractOverviewMarkdown("<h2>At a Glance</h2>\nCompleted:\n- Done"), "Completed:\n- Done");
});

test("updateOverviewCodeblockStatus writes generation timestamp into the source codeblock", async () => {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "glance-vault-"));
  const notePath = "04 - Daily/2026/04-April/2026-04-27-Monday.md";
  const absoluteNotePath = path.join(vaultPath, notePath);
  fs.mkdirSync(path.dirname(absoluteNotePath), { recursive: true });
  fs.writeFileSync(absoluteNotePath, "### At a Glance\n\n```glance\n*Generating overview...*\n```\n\n### Tasks\n", "utf8");

  const plugin = makePlugin(vaultPath);
  await plugin.updateOverviewCodeblockStatus(notePath, "**Completed:**\n- Done\n\n*Generated by Hermes · 2026-04-27 18:17:28 MDT*");

  const updated = fs.readFileSync(absoluteNotePath, "utf8");
  assert.match(updated, /```glance\n\*Overview generated by Hermes on 2026-04-27 18:17:28 MDT\*\n```/);
  assert.match(updated, /### Tasks/);
});

test("manual regenerate updates the already rendered codeblock without reopening the note", async () => {
  const plugin = makePlugin();
  await plugin.onload();
  plugin.generated.set("04 - Daily/2026/04-April/2026-04-27-Monday.md", "### At a Glance\nOld summary");
  plugin.generateOverviewForPath = async () => "### At a Glance\nNew summary";

  const el = makeElement();
  await plugin.processOverviewBlock(el, { sourcePath: "04 - Daily/2026/04-April/2026-04-27-Monday.md" });
  assert.match(el.children[0].renderedMarkdown, /Old summary/);

  await plugin.regenerateCurrentNoteOverview();

  assert.match(el.children[0].renderedMarkdown, /New summary/);
});
