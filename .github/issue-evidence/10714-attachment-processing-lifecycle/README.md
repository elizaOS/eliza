# #10714 attachment processing lifecycle slice

## Scope

This PR adds deterministic in-repo coverage for the accepted chat-upload MIME
set:

`validateChatImages` -> `buildChatAttachments` -> content-addressed media store
-> media serve headers/range handling -> `DefaultMessageService.processAttachments`.

It also persists additive `Media` metadata for chat uploads:
`mimeType`, `filename`, `size`, and `checksum`.

This is not the full issue closeout. The issue still requires the live-model
scenario trajectory and app upload UI screenshots/video.

## Verification

```bash
bun run --cwd packages/agent test -- src/api/chat-attachment-processing-lifecycle.test.ts src/api/chat-attachments.test.ts src/api/media-store.test.ts
```

Result: 3 files passed, 40 tests passed.

```bash
bun run --cwd packages/core test -- src/services/message.processAttachments.test.ts src/features/basic-capabilities/process-attachments-documents.test.ts src/features/basic-capabilities/providers/attachments.test.ts
```

Result: 3 files passed, 20 tests passed.

```bash
bunx biome check packages/agent/src/api/server-helpers.ts packages/agent/src/api/chat-attachment-processing-lifecycle.test.ts packages/agent/src/api/chat-attachments.test.ts
```

Result: clean.

## Typecheck

Attempted:

```bash
bun run --cwd packages/agent typecheck
```

Blocked before this diff by unresolved workspace package declarations:
`@elizaos/plugin-streaming`, `@elizaos/plugin-background-runner`, and
`@elizaos/cloud-routing`.

## Evidence not covered by this slice

- Real-LLM trajectory: not included in this deterministic unit/lifecycle slice.
- App upload UI screenshots/video: not included; the issue remains open for that lane.
- Stored media domain artifacts: the lifecycle test creates a temp
  `ELIZA_STATE_DIR`, asserts every file exists under the media store, validates
  serve headers and audio/video Range responses, and then deletes the temp store.
