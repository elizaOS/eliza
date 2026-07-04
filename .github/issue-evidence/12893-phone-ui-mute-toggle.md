# Issue 12893 — phone UI mute toggle

## Summary

- Added `muted` / `mutedScope` to `/api/inbox/chats` rows by resolving the same effective room/server mute state used by inbound message gating.
- Added `POST /api/inbox/chats/mute` for deterministic UI writes to room mute, server mute, and timed mute state.
- Added channel and server mute controls to the shared conversations sidebar used by the phone/mobile chat drawer.
- Preserved mute state in the conversations sidebar model and added a focused model test.

## Validation

- `bunx @biomejs/biome check packages/agent/src/api/inbox-routes.ts packages/ui/src/api/client-chat.ts packages/ui/src/components/conversations/ConversationsSidebar.tsx packages/ui/src/components/conversations/conversation-sidebar-model.ts packages/ui/src/components/conversations/conversation-sidebar-model.test.ts` — passed.
- `git diff --check` — passed.

## Blocked Validation

- `bun test packages/ui/src/components/conversations/conversation-sidebar-model.test.ts` — blocked in the sparse worktree because `lucide-react` is missing from the symlinked `node_modules`.
- `bun run --cwd packages/ui typecheck` — blocked by sparse dependency resolution; failures are missing packages such as `lucide-react`, `uuid`, `drizzle-orm`, Capacitor packages, and generated validation data.
- `bun run --cwd packages/agent typecheck` — blocked by sparse dependency resolution; the local duplicate-core type error was resolved, but remaining failures are missing packages such as `@elizaos/plugin-discord/*`, auth/vault/plugin-sql packages, and unrelated plugin-local-inference type errors from the shared dependency tree.
- `bun run --cwd packages/app audit:app` — attempted twice. First failed because `plugins/` was absent from sparse checkout. After adding `plugins`, `packages/native`, and `packages/tui`, the audit still failed before Playwright screenshots because view builds could not resolve `@elizaos/capacitor-phone`, `@elizaos/capacitor-messages`, and `@xterm/xterm` from the shared sparse dependency tree.
