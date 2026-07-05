# Status — 2026-07-05

Snapshot of the nine LifeOps Personal Assistant MVP workstreams. Live task truth
is [project board 15](https://github.com/orgs/elizaOS/projects/15); this file is
a dated, human-written summary. See [`../mvp/MVP.md`](../mvp/MVP.md) for scope
and the acceptance bar.

All nine workstreams have completed their research/design docs. **55 issues are
filed** on GitHub (#14321–#14376) and are being **added to board 15**; the
per-workstream **discussions are being opened** (master coordination thread in
Announcements, one `[MVP] <workstream>` kickoff per workstream in General).
"# issues" below is the count filed for each workstream.

| Workstream | Doc | Phase | # issues | Next action |
| --- | --- | --- | --- | --- |
| 1. Personas & UX journeys | [01](../research/01-mvp-product-personas.md) | research done, issues filed | 7 | Verify ADHD packs A1/A2 (P0) — live runs, hand-read trajectories |
| 2. In-chat widgets | [02](../research/02-chat-widget-system.md) | research done, issues filed | 7 | Fix dead connector `/forms/:id` link (P0); live-LLM round-trip coverage (P0) |
| 3. Launcher widgets | [03](../research/03-launcher-widgets.md) | research done, issues filed | 6 | Remove seven non-MVP home widgets + wallet respec (P0) |
| 4. Onboarding, tutorial & help | [04](../research/04-onboarding-tutorial-help.md) | research done, issues filed | 7 | Resurrect `app-live-e2e.yml` (P0); device e2e for default cloud path (P0) |
| 5. Chat window UX | [05](../research/05-chat-window-ux.md) | research done, issues filed | 6 | Lock transcript to vertical scroll (P0); history pagination (P0) |
| 6. View↔chat integration | [06](../research/06-views-chat-integration.md) | research done, issues filed | 6 | Consolidated `SETTINGS` action + wire settings writes (P0) |
| 7. Voice pipeline | [07](../research/07-voice-pipeline.md) | research done, issues filed | 7 | Benchmark cloud vs on-device + publish decision (P0); voice e2e (P0) |
| 8. Device testing pipeline | [08](../research/08-device-testing-pipeline.md) | research done, issues filed | 6 | Fix Android stale-install bug (P0); ship `devices:status` (P0) |
| 9. Doc-driven development | [09](../research/09-doc-driven-development.md) | research done, issues filed | 3 | PR-evidence gate stops accepting retired issue-evidence paths (P1) |

## How to update this file

Copy this file to a new dated snapshot (`status/YYYY-MM-DD.md`) when a milestone
warrants one, update each workstream's phase / issue count / next action from
board 15, and PR it. Board 15 is the live truth; this file is the periodic
human-written summary — no tooling generates it.
