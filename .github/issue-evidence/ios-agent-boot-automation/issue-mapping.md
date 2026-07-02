# iOS agent dev-automation epic — open-issue mapping (researched 2026-07-02)

Full analysis by the issue-mapping research pass. Summary of classifications:

- **CLOSED-BY-EPIC:** #11110 (XCUITest-lane agent 503) — contingent on the root-cause fix verified 2/2 healthy under an XCUITest-owned launch AND the boot-trace sink.
- **ADVANCED-BY-EPIC:** #8652 (item-1 iOS signing evidence; App Store submission + items 2–5 remain) · #10727 (iOS device lane enabler; 37/37 matrix rows + model publish gaps remain) · #10726 (iOS device leg + committed evidence; WER/latency + noise device runs remain) · #10724 (measured boot-time slice + telemetry instrument; battery/memory/CI budgets remain) · #10722 (the "no XCUITest driver, no iOS gesture spec" gap; Android non-blocking lane + WebKit reds #11112 remain) · #10200 (one-command iOS tooling slice) · #10936 (capture machinery enabler) · #8833 (HealthKit spam + blocker wiring slice) · #8621 (conditional: progress-aware polling serves dedicated cold-boot UX if transport-generic).
- **Pointer only:** #9033 (harness blocker removed; zero model/backend work claimed) · #10197 (CLOSED; follow-through comment with the on-device stability lane) · #11112 (cross-link if the device suite reproduces the slash-menu red).
- **PR collision (handled):** #11113 carried pre-#11104 duplicates (boot-splash-watchdog.ts, ios-runtime-mode-reconcile.ts, mobile-lane-guard.mjs) — coordination comment posted asking to rebase/drop; its 300s starting-runtime deadline is superseded by progress-aware polling here.
- Lineage: #11030 CLOSED via #11104 (merged to develop ddb281b914b).
