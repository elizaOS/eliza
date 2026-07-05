# Ongoing development — how we coordinate

Source of truth for in-flight product thinking on the way to the MVP: the
**LifeOps Personal Assistant** (chat, onboarding, the current views, and
centrally LifeOps — scheduling, calendar, coordination, reminders, goals,
todos, tasks). It serves children, adults with ADHD/ADD/Asperger's/autism,
neurotypical people, and elderly people alike — no therapy language, no special
rails; scenarios and tests cover real life (brush your teeth twice a day, work
out, get the report done on time, meet life goals, run a night-owl sleep
rhythm). Guiding constraint: **minimize new scope** — fix, test, and verify
what exists; prefer deleting over adding.

This folder is not published on the docs site — it is contributor-facing
working material, deliberately omitted from `docs.json`. Start with
[`mvp/MVP.md`](mvp/MVP.md); it is the first doc a new contributor reads.

## How work flows

The canonical board / claim / verify workflow is
[`docs/AGENT_COORDINATION.md`](../../../docs/AGENT_COORDINATION.md) (Issues =
work cards, Projects = state, Discussions = coordination rooms, PRs = code +
proof). This folder **adds a design-doc layer** on top of it: product and
planning work is doc-driven, so the path from idea to landed change is one
pipeline:

1. **Discussion** — conversation starts in
   [GitHub Discussions](https://github.com/elizaOS/eliza/discussions): one
   kickoff thread per workstream (General) plus the master coordination thread
   ([#14407](https://github.com/orgs/elizaOS/discussions/14407), Announcements).
   Discussions are for conversation, not storage — if something was decided, it
   belongs in a doc. (Live thread links: [`status/STATUS.md`](status/STATUS.md).)
2. **Design doc** — decisions land here as a PR: a `research/` doc for the
   initial audit + plan, a `design/` doc for an accepted design being built.
   A stale design doc is a bug; the PR that diverges from it updates it.
3. **Issues on the board** — each doc is broken into implementation-ready
   issues on the
   [LifeOps Personal Assistant MVP board (project 15)](https://github.com/orgs/elizaOS/projects/15),
   the active kanban. Claim work by commenting on the issue and moving its
   card. **Don't start unboarded MVP work** — file the issue first.
4. **PR with inline evidence** — every PR proves itself inline per
   [`PR_EVIDENCE.md`](../../../PR_EVIDENCE.md): a reviewer confirms it works
   *without reading the code*, from the artifacts attached to the PR.
5. **Doc updated on merge** — if implementation diverged from the doc, the same
   PR updates the doc, and the workstream row in [`status/STATUS.md`](status/STATUS.md)
   moves.

The three surfaces divide cleanly: **board 15 = task state**, **Discussions =
conversation**, **this folder = durable decisions**.

## Evidence mechanics

Evidence attaches **directly to the GitHub issue/PR** — drag-and-drop into the
description or a comment — so proof sits next to the change it proves. It is
**not committed to the repo**: the `.github/issue-evidence/` directory is
retired (it bloated every clone and detached proof from the conversation it
belonged to). The full standard is [`PR_EVIDENCE.md`](../../../PR_EVIDENCE.md);
the mechanics in one paragraph:

- **Video: MP4 only.** GitHub renders MP4 inline in issues/PRs; `.mov` /
  `.webm` degrade to bare links. Convert with
  `ffmpeg -i in.mov -c:v libx264 -pix_fmt yuv420p out.mp4`; compress to fit the
  upload limit, and if a clip genuinely can't fit, host it, link it, and attach
  a representative JPG still inline so the proof survives link rot.
- **Screenshots: JPG over PNG** — smaller and faster to review. PNG only where
  fine text or pixel-exact UI detail would be lost.
- **Logs:** pasted inline, wrapped in a collapsible `<details>` block when long.
- **Bug reports** must include a screenshot or recording of the **wrong**
  behavior — not a description of it.
- **Real-LLM trajectories** (live model, not the deterministic proxy) are
  required whenever agent/action/provider/prompt/model behavior changes;
  capture, then read them by hand.

## Index

| Doc | What it is |
| --- | --- |
| [`mvp/MVP.md`](mvp/MVP.md) | **The MVP definition** — product scope, 7 personas, real-life scenario matrix, in/out scope, honest state-of-the-code assessment, the 9 workstreams, and the evidence-driven acceptance bar. Read this first. |
| [`status/STATUS.md`](status/STATUS.md) | Dated status snapshot: per-workstream phase, issue counts, next action. Human-written; updated as milestones warrant. |
| [`research/01-mvp-product-personas.md`](research/01-mvp-product-personas.md) | MVP definition + 7 personas + real-life scenario→feature→test matrix; the persona-corpus verification gap (134/212 verified, ADHD/shift packs lagging). |
| [`research/02-chat-widget-system.md`](research/02-chat-widget-system.md) | In-chat widget registry, typed connector-agnostic interaction protocol, hosted-secret flow; six verification gaps (dead form link, missing date/time field, no live round-trip coverage). |
| [`research/03-launcher-widgets.md`](research/03-launcher-widgets.md) | Launcher/home widget audit — keep the resting home sparse (time/weather + notifications + wallet); wallet respec; remove seven non-MVP widgets. |
| [`research/04-onboarding-tutorial-help.md`](research/04-onboarding-tutorial-help.md) | Chat-first cloud-only onboarding, chat-native tutorial, help-as-knowledge; the live-verification lane is red 10+ days and no device lane covers the default cloud path. |
| [`research/05-chat-window-ux.md`](research/05-chat-window-ux.md) | Chat scrolling / gestures / search / mic on the continuous overlay; gestures done, but no history pagination, a horizontal-scroll leak, search unreachable, mic doesn't pulse. |
| [`research/06-views-chat-integration.md`](research/06-views-chat-integration.md) | View↔chat control: the gap list of view interactions lacking a semantic chat action; make every view a state renderer so voice-first works for free. |
| [`research/07-voice-pipeline.md`](research/07-voice-pipeline.md) | Cloud (Railway Kokoro/Whisper) vs on-device STT/TTS per platform; cloud path is unbenchmarked, uncovered in CI, and pinned to an English-only tiny STT model. |
| [`research/08-device-testing-pipeline.md`](research/08-device-testing-pipeline.md) | On-device Android+iOS fleet e2e: fix the stale-install bug, add a fleet `devices:status` build-stamp check, one triage bundle per run, one-command physical-iPhone lane. |
| [`research/09-doc-driven-development.md`](research/09-doc-driven-development.md) | The doc-driven + inline-evidence process itself: board/discussions/docs flow, retire `.github/issue-evidence/`, align the existing PR-evidence gate. Defines this folder. |
