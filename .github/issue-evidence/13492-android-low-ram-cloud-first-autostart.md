# Issue #13492 Evidence

## Change

Stock Android fresh installs no longer auto-start the bundled Bun/PGlite agent
before onboarding records a local runtime choice. The foreground service still
auto-starts on branded device images, and stock Android starts it only for the
persisted `local` mobile runtime mode.

## Manual Review

- Reviewed the native boot path in `MainActivity` and `ElizaBootReceiver`: both
  delegate to `ElizaAgentService.shouldAutoStart`.
- Reviewed the renderer runtime-mode vocabulary in
  `packages/ui/src/first-run/mobile-runtime-mode.ts`: `cloud`,
  `cloud-hybrid`, `remote-mac`, and `tunnel-to-mobile` do not require the
  bundled local service at first paint.
- Confirmed the issue's frozen boot trace is consistent with the previous fresh
  install behavior: `readRuntimeMode(context) == null` caused service startup,
  which reached PGlite initialization before the user could reach cloud sign-in.

## Verification

- Added JVM coverage in
  `packages/app-core/platforms/android/app/src/test/java/ai/elizaos/app/ElizaAgentAutostartPolicyTest.java`
  for branded, fresh stock, cloud, cloud-hybrid, remote, tunnel, and local
  modes.
- Local Gradle execution is blocked in this worktree because the host Java is
  11 while this Android project targets Java 21. CI's Android lane should run
  the added unit test with the configured Java toolchain.
