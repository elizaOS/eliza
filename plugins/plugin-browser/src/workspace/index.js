/**
 * Workspace browser command router — public barrel.
 *
 * This is the multi-backend workspace browser surface (formerly
 * `packages/agent/src/services/browser-workspace.ts` and friends). It owns:
 *
 *   - `browser-workspace.ts`      — public functions and the main command
 *                                   router `executeBrowserWorkspaceCommand`
 *   - `browser-workspace-types.ts` — exported types and interfaces
 *   - `browser-workspace-state.ts` — global mutable state
 *   - `browser-workspace-helpers.ts` — small utilities and command normalization
 *   - `browser-workspace-jsdom.ts`  — JSDOM loading and runtime install
 *   - `browser-workspace-elements.ts` — element finding, selector parsing
 *   - `browser-workspace-network.ts`  — HAR, network interception
 *   - `browser-workspace-forms.ts`    — form control interaction
 *   - `browser-workspace-snapshots.ts` — document snapshots, diff, PDF
 *   - `browser-workspace-desktop.ts`   — desktop bridge HTTP client
 *   - `browser-workspace-web.ts`       — web-mode (JSDOM-backed) command exec
 *   - `browser-capture.ts`             — frame-capture helpers for streaming
 *
 * Importers should prefer `@elizaos/plugin-browser/workspace` over the
 * specific `browser-workspace*` subpaths.
 */
export * from "./browser-capture.js";
export * from "./browser-workspace.js";
