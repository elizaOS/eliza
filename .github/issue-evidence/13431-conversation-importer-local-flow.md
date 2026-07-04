# #13431 Conversation Importer Local Flow Evidence

## Implementation

- Added the canonical conversation import entry point to `packages/ui/src/components/pages/MemoryViewerView.tsx` as a third Memories view mode: Feed / Browse / Import.
- Added source selection for ChatGPT, Claude, Hermes, and OpenClaw.
- Added local file parse, scrubbed preview counts/examples, explicit consent, import progress, completion state, and batch delete/manage for imported memory IDs.
- Added `client.deleteMemory()` against the existing `DELETE /api/memories/:id` route so batch delete removes real memory rows.
- Added `conversation-importer.ts` parser/redactor helpers and parser coverage for ChatGPT mapping, Claude-style `chat_messages`, plain-text fallback, redaction, and batch marker formatting.

## Verification Run

- `bunx @biomejs/biome check --write packages/ui/src/components/pages/conversation-importer.ts packages/ui/src/components/pages/conversation-importer.test.ts packages/ui/src/components/pages/MemoryViewerView.tsx packages/ui/src/api/client-chat.ts packages/ui/src/api/client-types-chat.ts` - passed after formatting.
- `bunx @biomejs/biome check packages/ui/src/components/pages/conversation-importer.ts packages/ui/src/components/pages/conversation-importer.test.ts packages/ui/src/components/pages/MemoryViewerView.tsx packages/ui/src/api/client-chat.ts packages/ui/src/api/client-types-chat.ts` - passed.
- `bun -e 'import { parseConversationImport, redactConversationImportText } from "./packages/ui/src/components/pages/conversation-importer.ts"; ...'` - direct parser smoke passed for ChatGPT mapping redaction and password/email redaction.

## Blocked Locally

- `bun run --cwd packages/ui test -- conversation-importer.test.ts` could not start because this clean worktree has no installed React dependency: `Cannot find module 'react/package.json'`.
- Full `bun run verify`, `packages/app audit:app`, screenshot capture, screen recording, and iOS simulator capture were not run locally because the host does not have a full Xcode/simctl installation and the filesystem had about 1.4 GB free after creating the isolated worktree.

## Evidence Still Needed Before Merge

- Re-run focused UI tests after workspace dependencies are installed.
- Run `bun run --cwd packages/app audit:app` and fill the Memories manual review verdicts.
- Attach before/after desktop and mobile screenshots plus a walkthrough recording of the Memories -> Import flow.
- Run iOS simulator build/capture on a host with full Xcode and attach logs/screenshots.
