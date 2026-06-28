# #9448 — finish home-widget surface

Evidence that the finishing pass (guarantee render · complete prioritization wiring · strip text/label/space · delete dead slots) is complete on `develop`.

## Artifacts
- `home-mobile-icon-first.png` — mobile home: every widget is icon + a single high-priority datum (Wallet −$125.50 Overdrawn · Goal "Ship the release" · Activity · Calendar "Design review" in 45m · Bell "Payment failed" 1 · Relationships "Confirm merge?" 1 · Inbox "Alex Rivera" 2 · Sleep 5h 45m Irregular), no label eyebrows, no empty placeholder cards.
- `home-desktop.png` — desktop home, same icon-first density.
- `home-screen-e2e.txt` — `test:home-screen-e2e` run: real ranked widgets render with their datum, layout-stable (CLS 0.0000), 0 page errors.
- `widget-prioritization-notification-tests.txt` — `home-priority`, `home-priority-integration`, `registry.home`, `widget-coverage`, `notification-store` (60 tests pass).
- `notification-allowlist-server-test.txt` — `misc-routes.agent-event` (server accepts the `notification` stream).

## Definition of Done → evidence
| AC | Status | Proof |
|---|---|---|
| Home renders ranked widgets on first launch, no empty placeholders | ✅ | `home-mobile-icon-first.png` / `home-desktop.png`; `home-screen-e2e.txt` ("home widget … renders" + datum) |
| Live notifications reach home via WS stream (allowlist) | ✅ | `"notification"` ∈ `AGENT_EVENT_ALLOWED_STREAMS` (`plugin-discovery-helpers.ts:750`); server proof `notification-allowlist-server-test.txt`; client WS-ingest proof in `widget-prioritization-notification-tests.txt` (`notification-store`: "WS handler ingests a notification-stream event") |
| Blocked/escalated orchestrator runs raise rank w/o manual attention | ✅ | `EVENT_TYPE_TO_SIGNAL_KIND`: `blocked→blocked`, `escalation→escalation`, `task_*`/`tool_running→workflow`; `home-priority-integration` covers "floats orchestrator activity for workflow lifecycle events" + per-widget `signalKinds` |
| `WidgetSlot` only mounted/reachable slots; no empty mounts | ✅ | `WidgetSlot` = `chat-sidebar \| character \| nav-page \| home` (const `WIDGET_SLOTS`, #9513); empty `heartbeats` host removed; `widget-coverage` "widget slot contract (#9448)" asserts the list + no bundled decls on retired slots |
| Coverage gate fails CI if a plugin resolves zero home widgets | ✅ | `widget-coverage` "resolves >=1 home widget for every app-manifest plugin" (≥32 plugins) |
| Reduce text/label/space | ✅ | `shared.tsx WidgetSection` dropped `uppercase`+`tracking-[0.16em]`, gap `space-y-1`→`space-y-0.5`; icon-first cards (label folded into `title`/`aria-label`) — see screenshots |
| `bun run verify` + UI widget suite green | ✅ | ui typecheck exit 0 (with #9513 applied); widget suite 60/60 + server test 1/1 (logs) |

## Landed
Final dead-slot prune merged via PR #9513 (`fix(ui): prune dead plugin widget slots`); all other items already on `develop` via #9143 PRs + the home-widget polish (`edfb6fdd24` icon-first cards, `a7749172b0` storybooks).
