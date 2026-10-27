<div align="center">

# saved-digest

**Turn the Instagram posts you save and forget into a searchable digest Claude Code can use.**

[![MIT license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node.js 24+](https://img.shields.io/badge/node-24%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Claude Code skill](https://img.shields.io/badge/Claude%20Code-skill-d97757)](skills/saved-digest/SKILL.md)
[![Runs locally](https://img.shields.io/badge/runs-locally-555)](SECURITY.md)

```
npm install -g github:coxy0/saved-digest && saved-digest setup
```

[Quick start](#quick-start) · [How it works](#how-it-works) · [Commands](#commands) · [Your data](#your-data) · [FAQ](#faq) · [Agent install guide](#instructions-for-ai-agents)

</div>

## Why

Instagram's saved tab is where good tips go to die:

- **No search.** Hundreds of saves in one endless grid, sorted by date.
- **The caption is bait.** "Comment SKILL and I'll DM you the link." The real tool or repo is only said out loud or flashed on screen.
- **It's in the wrong place.** You find the post on your phone in bed; you need it in your terminal two weeks later.

saved-digest reads your saves from your own browser, transcribes and watches the videos, and has Claude work out the real repo or site behind each one. You get:

- **A local web app**: your saves as a grid or list, grouped and searchable, with each video's links ready to open.
- **A skill for Claude Code**: ask *"any saved skills that would help with this repo?"* and get answers from your saves.

It's for you if you save lots of tech or AI posts and rarely go back to them, use Claude Code, and want your data on your own machine. Everything runs on your computer with your existing Claude Code subscription: no server, no account, nothing hosted, so it doesn't work from your phone alone. It only reads; it never posts, likes, comments or unsaves.

## Quick start

**Ask Claude Code:**

> Install saved-digest from https://github.com/coxy0/saved-digest. Follow the "Instructions for AI agents" in its README.

**Or do it yourself:**

```
npm install -g github:coxy0/saved-digest
saved-digest setup              # skill + local transcription, 3 to 10 minutes, once
saved-digest sync --max 20      # opens Chrome on Instagram: log in there yourself
saved-digest open               # web app at http://127.0.0.1:4317 (or ask your agent)
```

**Needs:** Node.js 24+, Google Chrome, Python 3.9+ (for transcription), and [Claude Code](https://claude.com/claude-code) installed and logged in. **Only Claude Code is supported for now; Codex and other agents are planned.** Tested on Windows; macOS and Linux should work, so please open an issue if something breaks.

## How it works

```
Instagram (your Chrome)  →  read saved posts  →  transcribe speech   →  watch key frames  →  group & summarise  →  web app + agent skill
   separate profile          slow, read-only       on your computer       Claude Haiku         Claude, 10 per call     127.0.0.1 only
```

1. **Collect.** Chrome opens with its own profile and scrolls your saved posts, reading captions, authors and video links from the data Instagram's page already loads. Only posts missing from that data are opened one by one.
2. **Transcribe.** faster-whisper transcribes speech locally. Audio never leaves your machine.
3. **Watch.** Claude Haiku reads up to 20 distinct frames per video, so silent videos and on-screen text are covered.
4. **Group and summarise.** Claude sorts posts by [your rules](#changing-how-posts-are-grouped) and writes a summary, tags and links, inferring the real resource behind "comment X for the link" bait.

A sync takes about 15 seconds per new post (20 posts in about 5 minutes). Later syncs only fetch new saves and stop scrolling once they reach stored posts. After a sync capped with `--max`, or one that failed, the next sync scrolls the whole grid once to fill the gap.

Both models run through your own `claude` CLI and count against your Claude Code plan; no API key is needed.

| Step | Model | When | Why |
|---|---|---|---|
| **Watch** | Claude Haiku | Once per new video, during sync | Simple and high-volume: reads the thumbnail and key frames (tiled 4 to an image) for URLs and names never said out loud. Fast and cheap enough for every video |
| **Group & summarise** | Your default model | Once per 10 new posts, and on `regroup` | Needs judgement: applying your rules and working out which repo a video means. Text only, so a few calls per sync |

`sync --no-transcribe` skips transcribing and watching: faster, but it misses anything not in the caption.

## Commands

The skill runs these for you; you rarely need them directly.

| Command | What it does |
|---|---|
| `saved-digest setup` | Install the skill and local transcription |
| `saved-digest sync [--max N] [--user NAME] [--no-transcribe]` | Collect, transcribe, watch and group new saved posts, then print a summary |
| `saved-digest sync --agent ...` | The same in the background, printing only milestones (what the skill uses) |
| `saved-digest sync --fresh` | Delete every stored post first (keeps your login and rules) |
| `saved-digest follow` | Progress of a running sync, or the summary of the last one |
| `saved-digest open` / `stop` | Start (or restart) the web app in the background, or stop it |
| `saved-digest` | Run the web app in this terminal until Ctrl+C |
| `saved-digest status` | Setup, running sync or web app, post counts, groups, rules file location |
| `saved-digest find [words]` | Posts as JSON, for agents or scripts |
| `saved-digest regroup` | Re-apply the rules to every post (about one Claude call per 10 posts) |

### Changing how posts are grouped

`~/.claude/saved-digest/rules.md` is pasted word for word at the top of every grouping request, so everything in it is an instruction to Claude: which groups exist (the web app's sections) and what goes where, what each summary should say (e.g. "for films, give the title and year"), and anything else to apply to every post.

The [default](rules.md) groups are Dev & AI tips, Design, Films & TV, Books, Music, Recipes, Fitness & health, Places to go and Learning, plus a short made-up group for anything else and Ignore (hidden from All) for memes, ads and spam.

Ask your agent to change it ("put cooking videos in Recipes", "merge these two groups") or edit it yourself. Changes apply to new posts; `saved-digest regroup` re-sorts existing ones. Delete the file to restore the default.

Whatever the rules say, comment bait is never repeated, links are only given when Claude is confident, and educational videos without speech are never ignored.

## Your data

Everything stays in `~/.claude/saved-digest/` (override with `SAVED_DIGEST_HOME`). Delete the folder to remove everything.

| Path | Contents |
|---|---|
| `data.db` | Posts: URL, author, caption, transcript, visual description, summary, group, links |
| `thumbs/` | Thumbnails |
| `profile/` | The Chrome profile holding your Instagram login. **Treat it like a password** |
| `rules.md` | Your [grouping rules](#changing-how-posts-are-grouped) |
| `sync.log` | Full log of the last sync (account name and post links, no captions) |
| `sync-complete` | Marker that the last sync stored every post it scrolled past, so the next can stop at stored posts |
| `venv/`, `models/` | Transcription tools and speech model (about 470 MB) |

Downloaded videos and a temporary cookie copy are deleted after each sync. Only post text and key frames leave your computer, sent to Claude through your own `claude` CLI. Because that text is written by strangers, those calls run outside your project with no tools, MCP servers or connectors (watching gets only Read, for the frame images). Details in [SECURITY.md](SECURITY.md).

## FAQ

<details>
<summary><strong>Can my Instagram account get banned?</strong></summary>

There is some risk: Instagram's terms do not allow automated access. saved-digest only reads, uses a real Chrome window, makes about 5 page loads per 100 posts, and downloads videos from Instagram's media servers without your login, so it looks like normal browsing. The realistic worst case is a rate limit or a "confirm it's you" check. Start with `--max 20`.

</details>

<details>
<summary><strong>How much Claude usage does it take?</strong></summary>

100 posts take about 10 grouping calls plus one Haiku call per video. Transcription is local and free. `saved-digest preview` prints exactly what would be sent for grouping.

</details>

<details>
<summary><strong>Does it work with Codex, Cursor or other agents?</strong></summary>

Not yet. Only Claude Code is supported for now; support for Codex and other agents is planned.

</details>

<details>
<summary><strong>Why not use the official Instagram API?</strong></summary>

It only covers business and creator accounts, and doesn't give access to saved posts.

</details>

<details>
<summary><strong>Can I run it in the cloud?</strong></summary>

Not the collection step: it needs your logged-in browser. You can schedule syncs on your own computer (Task Scheduler, cron or launchd). The web app only answers at `127.0.0.1` or `localhost` on this computer, so it can't be reached from your phone or through a proxy.

</details>

## Troubleshooting

| Problem | Fix |
|---|---|
| `Could not detect your Instagram username` | Run again with `--user <your username>` (detection relies on English page text) |
| `saved-digest: command not found` | npm's global bin folder isn't on your PATH; `npm prefix -g` shows where it is |
| `setup` fails creating the virtual environment | Python isn't on PATH as `python` (Windows) or `python3` (macOS/Linux) |
| `Instagram did not open the saved posts of @…` | Wrong username or expired login. Check `--user`, log in again in the saved-digest Chrome window, then sync again |
| `Found no saved posts` | Clear any dialog or security check in the saved-digest Chrome window and sync again. If it keeps happening, Instagram changed its page: please open an issue |
| Instagram shows a security check | Clear it in the saved-digest Chrome window, wait, then sync again with a smaller `--max` |
| Your agent asks to approve every command | Expected; you can allow `saved-digest` in its permission settings |

## Instructions for AI agents

You are installing saved-digest for a user. Follow these steps in order and tell the user what you are doing at each one.

1. **Check the requirements:** `node --version` (24+), `python --version` or `python3 --version` (3.9+), `claude --version`, and that Google Chrome is installed. If anything is missing, tell the user and ask before installing it. If `claude` is not logged in, ask the user to run `claude` once and log in.
2. **Install:** `npm install -g github:coxy0/saved-digest`, then confirm `saved-digest help` prints the command list. If it is not found, the npm global bin folder is not on PATH (`npm prefix -g`).
3. **Run `saved-digest setup`.** It downloads about 300 MB and takes 3 to 10 minutes, so run it in the background or with a timeout of at least 15 minutes.
4. **Skill:** `setup` already copied it to `~/.claude/skills/saved-digest`; it loads in new Claude Code sessions.
5. **Check:** `saved-digest status` should say `transcription  ready`.
6. **Hand over.** The first sync opens Chrome on Instagram and the user must log in there themselves; you cannot and must not do this. Ask how many posts to fetch first (suggest 20, about 5 minutes), then start `saved-digest sync --max N` in the background as the skill describes. Never add `--fresh` unless the user asks.

## Development

```
git clone https://github.com/coxy0/saved-digest
cd saved-digest
npm install
npm link
npm test
```

`saved-digest add <posts.json>` and `saved-digest preview` test grouping without Instagram. Instagram parsing lives in `src/instagram.js`, the part most likely to need fixes.

## Disclaimer

saved-digest is not affiliated with or endorsed by Instagram or Meta. It automates a browser you are logged in to, which Instagram's terms do not allow. You are responsible for how you use it.

## License

[MIT](LICENSE)
