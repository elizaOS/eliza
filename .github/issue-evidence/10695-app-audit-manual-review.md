# #10695 App Audit Manual Review

- Command: `bun run --cwd packages/app audit:app`
- Result: 349 Playwright audit tests passed.
- Relevant touched surfaces reviewed: `plugin-cockpit-gui`, `plugin-task-coordinator-gui`, `plugin-task-coordinator-tui` across mobile portrait, mobile landscape, desktop landscape, and iPad portrait.
- Manual verdict for relevant touched surfaces: `good`.
- Generic audit flags remaining on these screenshots are pre-existing app-shell token flags (`rgba(10, 10, 12, 0.42)`, `32px` shell radius), not introduced by the Gemma default/model label change.
- Manual inspection: reviewed `10695-app-audit-contact-sheet.png`; the copied cockpit/task-coordinator screenshots show no overlapping controls, clipped text, or broken responsive layout.
- Targeted Playwright recording: `E2E_RECORD=1 bun run --cwd packages/app audit:app -- -g "plugin-(cockpit|task-coordinator)-gui desktop-landscape"` passed 2 tests and produced `10695-cockpit-gui-desktop-recording.webm` and `10695-task-coordinator-gui-desktop-recording.webm`.

Copied screenshots:
- `10695-app-audit-contact-sheet.png`
- `10695-cockpit-gui-desktop-recorded-finish.png`
- `10695-task-coordinator-gui-desktop-recorded-finish.png`
- `10695-plugin-cockpit-gui-mobile-portrait.png`
- `10695-plugin-cockpit-gui-mobile-landscape.png`
- `10695-plugin-cockpit-gui-desktop-landscape.png`
- `10695-plugin-cockpit-gui-ipad-portrait.png`
- `10695-plugin-task-coordinator-gui-mobile-portrait.png`
- `10695-plugin-task-coordinator-gui-mobile-landscape.png`
- `10695-plugin-task-coordinator-gui-desktop-landscape.png`
- `10695-plugin-task-coordinator-gui-ipad-portrait.png`
- `10695-plugin-task-coordinator-tui-mobile-portrait.png`
- `10695-plugin-task-coordinator-tui-mobile-landscape.png`
- `10695-plugin-task-coordinator-tui-desktop-landscape.png`
- `10695-plugin-task-coordinator-tui-ipad-portrait.png`
