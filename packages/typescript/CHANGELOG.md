# Changelog

All notable changes to `@elizaos/core` (TypeScript package) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- **Database adapter return types**: `IDatabaseAdapter` now correctly declares `updateAgents`, `deleteAgents`, and `deleteParticipants` as returning `Promise<boolean>` instead of `Promise<void>`.

  **Why this change:** Implementations (DatabaseAdapter, InMemoryDatabaseAdapter, plugin-sql, plugin-localdb, plugin-inmemorydb) have always returned a boolean to indicate success or failure. The interface had been out of sync, which caused TypeScript declaration build failures and type errors when passing adapters or runtime to code expecting `IAgentRuntime` / `IDatabaseAdapter`. Aligning the interface with implementations restores a consistent contract: callers can rely on the return value for error handling and UX (e.g. "Agent removed" vs "Failed to remove").

  **Affected:** `packages/typescript/src/types/database.ts` (interface only; no behavioral change in adapters or runtime).
