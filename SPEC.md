# Obsidian At a Glance — Build Specification

## Overview

Build an Obsidian plugin + Hermes AI integration that automatically generates a 7-day "At a Glance" summary and writes it into each new daily note. The system has three parts:

1. **Obsidian Plugin** (`obsidian-at-a-glance`) — a local `.obsidian/plugins/` community-style plugin
2. **Hermes Prompt/Behavior** — instructions for how Hermes should generate the overview
3. **Daily Note Template** — updated template with the `ai-overview` codeblock placeholder

---

## Architecture

```
[Obsidian Daily Note]                   [Local REST API]           [Hermes CLI]
      |                                        |                        |
      |  Daily note created (template)         |                        |
      |                                          |                        |
      |  Plugin detects ```ai-overview block    |                        |
      |  in newly rendered note                  |                        |
      |                                          |                        |
      |  ──────────────────────────────────────► |  GET /vault/04 - Daily/|
      |        (fetch last 7 days of notes)      |  (list + read files)  |
      |                                          |                        |
      |◄─────────────────────────────────────── |  (returns note texts)  |
      |        (7 days of note content)          |                        |
      |                                          |                        |
      |  Spawn hermes chat -q '<prompt>' ────────────────────────────────►|
      |        (prompt includes note texts +    |                        |
      |         system instructions)             |  Reads ~/.hermes/    |
      |                                          |  config.yaml         |
      |                                          |  Uses OpenRouter     |
      |                                          |  Connects to Honcho  |
      |◄──────────────────────────────────────── |  memory on :8000      |
      |        (At a Glance markdown)            |                        |
      |                                          |                        |
      |  PATCH At a Glance into daily note ────► |                        |
      |  Target-Type: DAILY NOTE::[Date]::[Hdr]  |                        |
```

**Key Design Constraints:**
- Hermes runs as a LOCAL CLI subprocess (`/Users/Laura/.local/bin/hermes`), NOT on a remote server
- The server (qas1.vast.uccs.edu) is only used for Honcho memory
- No SSH tunnel needed for this workflow
- Plugin spawns `hermes chat -q '<prompt>'` and captures stdout
- No hotkey — fully event/codeblock driven

---

## Part 1: Obsidian Plugin

### Location
`/Users/Laura/Obsidian/Primary-Vault/.obsidian/plugins/obsidian-at-a-glance/`

### Files to Create

```
obsidian-at-a-glance/
├── manifest.json
├── main.js
├── styles.css
└── README.md
```

### manifest.json

```json
{
  "id": "obsidian-at-a-glance",
  "name": "At a Glance",
  "version": "0.1.0",
  "minAppVersion": "1.4.0",
  "description": "Generate a 7-day At a Glance in daily notes via Hermes",
  "author": "Laura",
  "authorUrl": "",
  "isDesktopOnly": true,
  "fundingUrl": []
}
```

### main.js — Core Logic

The plugin must:

1. **Register a `ai-overview` codeblock processor** using `registerMarkdownCodeBlockProcessor("ai-overview", ...)`

2. **On codeblock render:**
   a. Read the last 7 days of daily notes via the Local REST API (`http://127.0.0.1:27124`)
      - Endpoint: `GET /vault/04 - Daily/[year]/[month-folder]/` to list files
      - Then `GET /vault/[filepath]` to read each note's content
      - Filter to last 7 calendar days (not including today)
   b. Concatenate all note content into a single context string
   c. Build a prompt for Hermes (see Part 2 below)
   d. Spawn `hermes chat -q '<prompt>'` as a subprocess using `child_process.spawn`
      - Capture stdout incrementally (use `on('data')` streaming if possible)
      - Hermes outputs streaming text to stdout — collect it all until `close` event
   e. Parse the output — extract the markdown content (strip any non-markdown wrapper text)
   f. Replace the codeblock content with the rendered At a Glance markdown
   g. PATCH the At a Glance directly into the daily note via Local REST API:
      - `PATCH /vault/[today's note path]`
      - Header: `Target-Type: DAILY NOTE::[Today's Date e.g. Monday, April 27, 2026]::At a Glance`
      - Body: the At a Glance markdown
      - Note: the PATCH appends/creates the `### At a Glance` section under the heading

3. **Error handling:**
   - If Local REST API is unreachable, show a toast: "At a Glance: Local REST API not reachable"
   - If Hermes subprocess fails, show toast: "At a Glance: Hermes error — see console"
   - Wrap the whole processor in try/catch

### API Integration Details

**Base URL:** `http://127.0.0.1:27124`
**Auth Header:** `Authorization: Bearer [REDACTED — see config at end of this spec]`

**Endpoints used:**
- `GET /vault/` — list root vault files
- `GET /vault/[encoded-path]` — read a specific file
- `PATCH /vault/[encoded-path]` — update a file (append under heading)
  - Header `Target-Type: DAILY NOTE::[Date]::[Heading]`
  - Body: JSON `{ "data": "markdown string" }`

**Finding daily notes:**
- Daily notes live in: `04 - Daily/[year]/[month-name]/`
- File naming: `YYYY-MM-DD-DayOfWeek.md` (e.g., `2026-04-27-Monday.md`)
- To find last 7 days: compute dates from today minus 1 to today minus 7, construct file paths
- Month folders use full month name (e.g., `04-April`, `05-May`)

**Today's date for PATCH:**
- Use `moment` (or the obsidian Moment library) to format: `dddd, MMMM D, YYYY`
- Example: `Monday, April 27, 2026`
- Today's note path: `04 - Daily/2026/04-April/2026-04-27-Monday.md`

### styles.css

Minimal styling for the At a Glance section:
- Use a subtle background tint (e.g., `rgba(120, 120, 200, 0.05)`)
- Add a left border accent (3px solid accent color)
- Round corners (6px)
- Padding (12px 16px)
- Monospace font for any metadata lines
- Italic style for the "Generated by Hermes" attribution line

### README.md

Brief install instructions: copy folder to `.obsidian/plugins/`, enable in Community Plugins.

---

## Part 2: Hermes Behavior Specification

### Purpose

When called via `hermes chat -q '<prompt>'` with the 7-day context, Hermes must:

1. **Read** all 7 days of note content passed in the prompt
2. **Synthesize** an "At a Glance" section covering:
   - **Tasks completed** (checked off tasks from each day)
   - **Active tasks** (uncompleted tasks, especially recurring/due ones)
   - **Journal highlights** (key entries from `### Journal` sections)
   - **Newly created notes** (detected from `### Created` sections if present, or filename analysis)
   - **Upcoming deadlines** (tasks with due dates in the next 7 days)
3. **Output** ONLY the rendered markdown — no preamble like "Here's your overview:", no postamble, no JSON wrapper
4. **Format:**
   ```markdown
   ### At a Glance

   **Week of [start date] – [end date]**

   #### Tasks
   - [x] Completed task from [Day]
   - [ ] Still open: task description
   ...

   #### Highlights
   - [Day]: journal highlight text
   ...

   #### Created
   - [[Note Name]] — created [Day]
   ...

   #### Upcoming
   - [Due date]: task description
   ...

   *Generated by Hermes · [HH:MM timestamp]*
   ```

### Hermes Invocation

The plugin calls:
```bash
hermes chat -q '<full-prompt>'
```

Where `<full-prompt>` is:
```
You are an At a Glance generator. Read the following 7 days of notes and produce a concise "At a Glance" section.

RULES:
- Output ONLY markdown starting with "### At a Glance"
- No preamble, no explanation, no JSON, no quotes
- Cover: tasks completed, active tasks, journal highlights, newly created notes, upcoming deadlines
- Be concise — bullet points, not paragraphs
- Add "*Generated by Hermes · [current time]*" as the last line

=== NOTES (oldest to newest) ===

[Day: YYYY-MM-DD]
(note content here)

=== END NOTES ===

Today's date: [YYYY-MM-DD]
Today is: [dddd, MMMM D, YYYY]
```

---

## Part 3: Daily Note Template Update

### Target File

The daily note template — locate it in the vault (likely in `.obsidian/templates/` or similar). Add this block:

```markdown
## At a Glance

```ai-overview
*Generating overview...*
```

```

### Notes

- The `ai-overview` codeblock processor replaces its own content — the placeholder text is just for UX
- Alternatively, the block can be empty (the processor handles empty blocks gracefully)
- The section header `## At a Glance` (not `###`) matches the hierarchy: `Daily Note > ## At a Glance > ai-overview block`

---

## Configuration

**Local REST API:**
- URL: `http://127.0.0.1:27124`
- Bearer token: `[REDACTED — use value from environment or a config file]`

**Hermes:**
- Binary: `/Users/Laura/.local/bin/hermes`
- Config: `/Users/Laura/.hermes/config.yaml`

**Obsidian Vault:**
- Path: `/Users/Laura/Obsidian/Primary-Vault`

**Daily Notes Folder:**
- Path: `04 - Daily/`
- Year folders: e.g., `2026/`
- Month folders: e.g., `04-April/`
- File pattern: `YYYY-MM-DD-DayOfWeek.md`

---

## Acceptance Criteria

1. The plugin folder can be dropped into `.obsidian/plugins/` and enabled in Obsidian
2. When a daily note containing ` ```ai-overview ` is opened/rendered, the processor fires
3. The processor reads the last 7 days of notes via the Local REST API
4. Hermes is spawned with the correct prompt and produces valid markdown
5. The At a Glance section appears under `## At a Glance` in the current daily note
6. The codeblock placeholder text is replaced with the rendered overview
7. If Local REST API is down, a user-friendly toast is shown
8. If Hermes fails, a user-friendly toast is shown with a console error
9. The `styles.css` gives the At a Glance a visually distinct but unobtrusive appearance

---

## File Checklist

```
obsidian-at-a-glance/
├── manifest.json       ← plugin manifest
├── main.js             ← core plugin logic (codeblock processor + API calls + subprocess)
├── styles.css          ← visual styling for the overview section
└── README.md           ← install/enable instructions
```

Also update the daily note template in the vault to include the `ai-overview` codeblock placeholder.
