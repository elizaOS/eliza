# #9948 — RoleProvider wired into the app shell

`ShellRoleProvider` (observes the app auth status via `useAuthStatus({observeOnly})`,
maps it to a canonical role with the pure, tested `deriveShellRole`, and provides
`RoleProvider`) is mounted once in `packages/app/src/main.tsx` around `<App/>`,
under `AppProvider`. Any view can now gate developer/owner surfaces with
`useRole()` / `<RoleGate>`.

`app-home-with-rolewiring.png` — the app boots and renders cleanly with the
wiring in place (Playwright: 0 page errors, content rendered, #root mounted).
This is the interim role derivation (local→OWNER, authenticated→USER, else GUEST)
until `/api/auth/me` returns the server-resolved boundary role; only
`deriveShellRole` changes when that lands. `deriveShellRole` has 3 unit tests.
