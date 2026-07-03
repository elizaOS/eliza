# Scenario Catalog Inventory

Default packages/test scenarios: 707
With pending included: 713
plugin-personal-assistant scenarios: 190
plugin-app-control scenarios: 13
plugin-agent-orchestrator scenarios: 8
scenario-runner test scenarios: 34
Unified scenario catalog entries: 952

## Corpus coverage split (#10757)

Honest three-way split across the full scenario corpus, so deterministic PR
coverage, credentialed live-matrix coverage, and platform-gated coverage that
is deferred (no runner yet) are counted separately rather than lumped together:

- keyless PR-deterministic: 65
- credentialed live-only (live matrix): 877
- deferred platform-gated (no runner yet): 16
- total corpus: 958

### Deferred platform-gated scenarios

- `bluebubbles.imessage.receive` (os: macos) — requires a macOS host for native integrations (SelfControl/Screen Time, iMessage/BlueBubbles, mac remote-control); no self-hosted macOS runner yet [runner: eliza-e2e-macos]
- `bluebubbles.imessage.send-blue` (os: macos) — requires a macOS host for native integrations (SelfControl/Screen Time, iMessage/BlueBubbles, mac remote-control); no self-hosted macOS runner yet [runner: eliza-e2e-macos]
- `imessage.cross-reference-contact` (os: macos) — requires a macOS host for native integrations (SelfControl/Screen Time, iMessage/BlueBubbles, mac remote-control); no self-hosted macOS runner yet [runner: eliza-e2e-macos]
- `imessage.read-incoming` (os: macos) — requires a macOS host for native integrations (SelfControl/Screen Time, iMessage/BlueBubbles, mac remote-control); no self-hosted macOS runner yet [runner: eliza-e2e-macos]
- `imessage.reply-with-confirmation` (os: macos) — requires a macOS host for native integrations (SelfControl/Screen Time, iMessage/BlueBubbles, mac remote-control); no self-hosted macOS runner yet [runner: eliza-e2e-macos]
- `remote.mobile-controls-mac` (os: macos) — requires a macOS host for native integrations (SelfControl/Screen Time, iMessage/BlueBubbles, mac remote-control); no self-hosted macOS runner yet [runner: eliza-e2e-macos]
- `selfcontrol.block-websites.followup-after-detour` (os: macos) — requires a macOS host for native integrations (SelfControl/Screen Time, iMessage/BlueBubbles, mac remote-control); no self-hosted macOS runner yet [runner: eliza-e2e-macos]
- `selfcontrol.block-websites.manual-indefinite` (os: macos) — requires a macOS host for native integrations (SelfControl/Screen Time, iMessage/BlueBubbles, mac remote-control); no self-hosted macOS runner yet [runner: eliza-e2e-macos]
- `selfcontrol.block-websites.simple` (os: macos) — requires a macOS host for native integrations (SelfControl/Screen Time, iMessage/BlueBubbles, mac remote-control); no self-hosted macOS runner yet [runner: eliza-e2e-macos]
- `selfcontrol.conditional-unblock.fixed-duration` (os: macos) — requires a macOS host for native integrations (SelfControl/Screen Time, iMessage/BlueBubbles, mac remote-control); no self-hosted macOS runner yet [runner: eliza-e2e-macos]
- `selfcontrol.harsh-mode.no-bypass` (os: macos) — requires a macOS host for native integrations (SelfControl/Screen Time, iMessage/BlueBubbles, mac remote-control); no self-hosted macOS runner yet [runner: eliza-e2e-macos]
- `selfcontrol.self-set-enforcement.ask-before` (os: macos) — requires a macOS host for native integrations (SelfControl/Screen Time, iMessage/BlueBubbles, mac remote-control); no self-hosted macOS runner yet [runner: eliza-e2e-macos]
- `selfcontrol.self-set-enforcement.enforces-yes` (os: macos) — requires a macOS host for native integrations (SelfControl/Screen Time, iMessage/BlueBubbles, mac remote-control); no self-hosted macOS runner yet [runner: eliza-e2e-macos]
- `selfcontrol.unblock-websites.ambiguous-x` (os: macos) — requires a macOS host for native integrations (SelfControl/Screen Time, iMessage/BlueBubbles, mac remote-control); no self-hosted macOS runner yet [runner: eliza-e2e-macos]
- `selfcontrol.unblock-websites.before-scheduled-end` (os: macos) — requires a macOS host for native integrations (SelfControl/Screen Time, iMessage/BlueBubbles, mac remote-control); no self-hosted macOS runner yet [runner: eliza-e2e-macos]
- `selfcontrol.unblock-websites.no-active-block` (os: macos) — requires a macOS host for native integrations (SelfControl/Screen Time, iMessage/BlueBubbles, mac remote-control); no self-hosted macOS runner yet [runner: eliza-e2e-macos]

Default package pr-deterministic scenarios: 27
Workflow covered default package scenarios: 685/707
Deferred default package scenarios tracked by follow-up: 22
Missing default package scenarios from current workflow coverage: 0

## Deferred IDs

- `activity.browser-extension-feeds-data` - tracked in #10757; not currently part of the PR/live matrix
- `activity.per-app.today` - tracked in #10757; not currently part of the PR/live matrix
- `activity.per-site.social` - tracked in #10757; not currently part of the PR/live matrix
- `activity.privacy-redaction` - tracked in #10757; not currently part of the PR/live matrix
- `backup.restore-recall` - tracked in #10757; not currently part of the PR/live matrix
- `security.should-respond-injection-gate` - tracked in #10757; not currently part of the PR/live matrix
- `selfcontrol.block-apps.ios-capacitor` - tracked in #10757; not currently part of the PR/live matrix
- `selfcontrol.block-apps.mobile` - tracked in #10757; not currently part of the PR/live matrix
- `selfcontrol.block-websites.followup-after-detour` - tracked in #10757; not currently part of the PR/live matrix
- `selfcontrol.block-websites.manual-indefinite` - tracked in #10757; not currently part of the PR/live matrix
- `selfcontrol.block-websites.simple` - tracked in #10757; not currently part of the PR/live matrix
- `selfcontrol.conditional-unblock.fixed-duration` - tracked in #10757; not currently part of the PR/live matrix
- `selfcontrol.harsh-mode.no-bypass` - tracked in #10757; not currently part of the PR/live matrix
- `selfcontrol.integration-with-todos.auto-block` - tracked in #10757; not currently part of the PR/live matrix
- `selfcontrol.nighttime-wind-down` - tracked in #10757; not currently part of the PR/live matrix
- `selfcontrol.override-requires-auth` - tracked in #10757; not currently part of the PR/live matrix
- `selfcontrol.self-set-enforcement.ask-before` - tracked in #10757; not currently part of the PR/live matrix
- `selfcontrol.self-set-enforcement.enforces-yes` - tracked in #10757; not currently part of the PR/live matrix
- `selfcontrol.self-set-enforcement.respects-no` - tracked in #10757; not currently part of the PR/live matrix
- `selfcontrol.unblock-websites.ambiguous-x` - tracked in #10757; not currently part of the PR/live matrix
- `selfcontrol.unblock-websites.before-scheduled-end` - tracked in #10757; not currently part of the PR/live matrix
- `selfcontrol.unblock-websites.no-active-block` - tracked in #10757; not currently part of the PR/live matrix

## Missing IDs

- none

HTML catalog viewer: /Users/shawwalters/eliza-workspace/eliza/eliza/.claude/worktrees/eliza-10757/.github/issue-evidence/10757-scenario-inventory-harness/catalog-inventory/viewer/index.html

## Scenario Run Artifacts

- none discovered

Full lists are in this directory as `.txt` files; exact missing IDs are in `workflow-coverage.json`.
