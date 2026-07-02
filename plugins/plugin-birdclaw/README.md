# @elizaos/plugin-birdclaw

[Birdclaw](https://birdclaw.sh) local-first Twitter/X memory for elizaOS.

Birdclaw keeps a private archive of your Twitter/X life — timeline, mentions,
DMs, likes, bookmarks — in a single SQLite database on your machine, imported
from your Twitter archive and optionally kept fresh with live syncs. This
plugin connects that archive to your Eliza agent:

- **Birdclaw app** in the launcher — browse Timeline / Mentions / Posted /
  Likes / Bookmarks / Inbox, trigger live syncs, see who still needs a reply.
  One spatial component renders the same view on GUI, XR, and the terminal.
- **`BIRDCLAW` agent action** — ask your agent things like *"search my tweets
  for that thread about sync engines"*, *"which mentions still need a reply?"*,
  *"pull my latest bookmarks"*, or *"what happened on Twitter today?"*
  (digest). Owner-only: this is your private archive.
- **`/api/birdclaw/*` routes** — status, tweets, inbox, sync, digest; the view
  and any other client drive these.

## Setup

```bash
brew install steipete/tap/birdclaw   # or build from source (Node 26)
birdclaw init                        # create ~/.birdclaw + seed the demo data
birdclaw import archive <path>       # import your Twitter archive
```

That's it — the agent auto-loads the plugin when it finds the `birdclaw`
binary (or an existing `~/.birdclaw`). No config required. Without birdclaw
installed the app shows a setup screen and the agent action stays dormant.

Optional knobs: `BIRDCLAW_BIN` (explicit binary path), `BIRDCLAW_HOME`
(alternate data root), `BIRDCLAW_OPENAI_API_KEY` (enables birdclaw's AI
digest/scoring), `ELIZA_BIRDCLAW=1/0` (force on/off).

Live sync needs one of birdclaw's transports (`xurl` OAuth2 or `bird` browser
cookies) — see the [birdclaw docs](https://github.com/steipete/birdclaw).
Everything else (browse, search, inbox, digest) works on the local archive
alone.

## Development

```bash
bun run --cwd plugins/plugin-birdclaw test        # offline unit suite
bun run --cwd plugins/plugin-birdclaw test:real   # against the real CLI
bun run --cwd plugins/plugin-birdclaw build
```

See [CLAUDE.md](./CLAUDE.md) for the full surface, layout, and gotchas.
