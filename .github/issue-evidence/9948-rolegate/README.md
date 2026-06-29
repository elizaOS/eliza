# #9948 — UI `RoleGate` / `useRole` primitive (live render, web + android)

The new canonical UI role-gating primitive (`packages/ui/src/hooks/useRole.tsx` +
`packages/ui/src/components/RoleGate.tsx`) rendered for all four role tiers. Each
card wraps the same three rows in `<RoleGate minRole=…>`; ranking goes through the
canonical core `roleRank` / `satisfiesRoleGate`.

Expected (and observed) gating:

| role  | Everyday (USER) | Admin tools (ADMIN) | Wallet/API keys (OWNER) |
|-------|-----------------|---------------------|-------------------------|
| OWNER | visible         | visible             | visible                 |
| ADMIN | visible         | visible             | **hidden**              |
| USER  | visible         | **hidden**          | **hidden**              |
| GUEST | **hidden**      | **hidden**          | **hidden**              |

- `rolegate-web.png` — Playwright + headless chromium (host). Playwright asserted
  6 total hidden rows across the four cards (1 ADMIN + 2 USER + 3 GUEST).
- `rolegate-android-emulator.png` — the **android simulator** (`emulator-5554`)
  Chrome at `http://10.0.2.2:2188/rolegate.html`.
- `rolegate-android-device.png` — a **connected physical device**
  (`53081JEBF11586`) Chrome at `http://localhost:2188/...` via `adb reverse`.

All three render the same correct gating, confirming the primitive behaves
identically on linux web, the android emulator, and a real android device. The
component itself is covered by 7 jsdom unit tests (`RoleGate.test.tsx`).
