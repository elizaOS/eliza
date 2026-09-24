# @elizaos/app

Eliza application host, renderer, and native platform tooling for web, desktop, iOS, and Android.

Use `bun run dev` at the repository root; concurrent worktrees use `bun run --cwd packages/app dev:shared`. Native targets require their platform SDKs. UI changes require `bun run --cwd packages/app audit:app` and inspection of affected desktop/mobile captures. Orange is the accent; orange controls hover darker orange.

Build, test, and setup: [README.md](README.md).
