# AI Overview

AI Overview is a desktop-only Obsidian plugin that generates a 7-day daily-note summary through the local Hermes CLI and writes the rendered markdown back into the current daily note.

## Install

1. Copy this folder to:

   ```text
   /Users/Laura/Obsidian/Primary-Vault/.obsidian/plugins/obsidian-ai-overview/
   ```

2. Enable **AI Overview** in Obsidian under **Settings -> Community plugins**.

3. Make sure the Obsidian Local REST API is running at:

   ```text
   http://127.0.0.1:27124
   ```

4. Set one of these environment variables before launching Obsidian:

   ```text
   OBSIDIAN_LOCAL_REST_API_TOKEN
   OBSIDIAN_REST_API_TOKEN
   LOCAL_REST_API_TOKEN
   ```

5. Make sure Hermes is installed at:

   ```text
   /Users/Laura/.local/bin/hermes
   ```

## Daily Note Placeholder

Add this block to the daily note template:

````markdown
## AI Overview

```ai-overview
*Generating overview...*
```
````

When the daily note renders, the plugin reads the previous 7 calendar days from `04 - Daily/`, asks Hermes for a concise overview, renders the markdown in place, and patches the overview back into the daily note through the Local REST API.
