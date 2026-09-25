# @elizaos/app

Eliza application host, renderer, and native platform tooling for web, desktop, iOS, and
Android.

Start the app and API with `bun run dev` from the repository root. Native targets
require their platform SDKs; available build/install commands are in package.json.
Concurrent worktrees should use `bun run --cwd packages/app dev:shared`. UI changes
require `bun run --cwd packages/app audit:app` and inspection of affected desktop/mobile
captures.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/app build  # build
bun run --cwd packages/app test   # tests
```

For a system APK targeting Pixel/Cuttlefish ARM64 and x86_64, set
`ELIZA_ANDROID_TARGET_ABIS=x86_64,arm64-v8a` when running
`bun run --cwd packages/app build:android:system`. Omitting the variable retains
all runtime targets, including the separately pinned RISC-V artifact requirement.
