# Security and privacy

saved-digest runs on your computer and touches a logged-in Instagram account, so this file lists exactly what it does.

## Instagram

- It opens Chrome with a separate profile at `~/.claude/saved-digest/profile`, never your normal Chrome profile. You log in there yourself; saved-digest never sees or stores your password.
- It only reads: it scrolls your saved posts and reads the post data that Instagram's own page loads while scrolling (caption, author, thumbnail and video links). A post missing from that data is opened on its own page instead. It never likes, follows, comments, saves, unsaves or sends anything.
- No AI model controls the browser. The steps are a fixed script.
- Videos are downloaded straight from Instagram's media servers using the links in that data, without your cookies, so the downloads are not tied to your account.
- For posts without such a link, the download tool (yt-dlp) fetches the post as you. For that, each sync copies the Instagram cookies from that profile into a temporary folder.
- The temporary folder, with any cookies and videos, is deleted when the run ends, even if it fails.

## Stored on your computer

In `~/.claude/saved-digest/`: post URLs, authors, captions, transcripts, descriptions of what is on screen, summaries, groups and thumbnails, plus the Chrome profile, your rules and the transcription tools. Nothing is uploaded anywhere except the Claude calls below.

## Sent to Claude

All calls go through your own Claude Code CLI (`claude -p`), under your account, with session history turned off.

- **Grouping:** your rules, and for each post its URL, author, caption, transcript (first 3,000 characters) and visual description. `saved-digest preview` prints the exact text.
- **Watching videos:** the thumbnail and a few contact sheets of key frames from each video, sent to Claude Haiku, which may only read those image files.

Transcription runs locally with faster-whisper; audio never leaves your computer.

## Web app

- Listens on `127.0.0.1` only, so other devices on your network cannot reach it, and answers only requests addressed to `127.0.0.1` or `localhost`, so a website cannot reach it by pointing its own domain at your computer (DNS rebinding).
- Every API request needs a random token that changes each time the server starts, and requests from other websites (a foreign `Origin`) are rejected.
- It only reads data. There are no endpoints that change anything.
- Text from Claude is shown as text, never as HTML, and only `http(s)` links are kept.

## Reporting a problem

Please open a GitHub issue, or for anything sensitive, contact the maintainer privately through GitHub.
