// Compatibility re-export of the full @elizaos/ui public surface for
// app/plugin consumers that still `import { … } from "@elizaos/app-core"`.
// The Wave A refactor (eliza commit 5a6f5f337) moved React surfaces
// out of app-core into @elizaos/ui but didn't backfill the bridge here.
// Re-export everything from ui — the implementations live there.
// Server-only barrels don't include this file (see src/index.ts), so
// it doesn't pull React/DOM types into the runtime/agent chunks.
export * from "@elizaos/ui";
