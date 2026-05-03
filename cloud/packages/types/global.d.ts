/**
 * Global Type Declarations
 *
 * Extends built-in types and declares missing module types.
 */

// =============================================================================
// Browser API Extensions
// =============================================================================

/**
 * Safari's prefixed AudioContext
 * @see https://developer.mozilla.org/en-US/docs/Web/API/AudioContext
 */
interface Window {
  webkitAudioContext: typeof AudioContext;
}

/**
 * Cloudflare's Worker types expose `Body.json<T>()` without a default generic,
 * so existing untyped `response.json()` calls become `unknown` across the app.
 * Keep the historical DOM behavior for unparameterized calls while still
 * allowing typed callers to specify `json<MyShape>()`.
 */
interface Body {
  json<T = any>(): Promise<T>;
}

interface Request {
  json<T = any>(): Promise<T>;
}

interface Response {
  json<T = any>(): Promise<T>;
}

/**
 * Vite's `import.meta.glob` augmentation. The frontend uses `vite/client` to
 * type this, but server/test tsconfigs don't pull in Vite. Files like
 * `packages/lib/blog.ts` are imported on both sides, so we declare the API
 * globally with the same shape Vite ships.
 */
interface ImportGlobOptions<Eager extends boolean, AsType extends string> {
  eager?: Eager;
  import?: string;
  query?: string | Record<string, string | number | boolean>;
  exhaustive?: boolean;
  base?: string;
  as?: AsType;
}

interface ImportMeta {
  glob<T = unknown>(
    pattern: string | string[],
    options?: ImportGlobOptions<boolean, string>,
  ): Record<string, T>;
}

// =============================================================================
// External Package Type Declarations
// =============================================================================

/**
 * @elizaos/plugin-sql/node - Database adapter factory
 * Type definitions are missing from the published package
 */
declare module "bs58";
declare module "@xyflow/react/dist/style.css";
declare module "@xterm/xterm/css/xterm.css";
declare module "highlight.js/styles/github-dark.css";

declare module "@elizaos/plugin-sql/node" {
  import type { IDatabaseAdapter, UUID } from "@elizaos/core";

  interface DatabaseAdapterConfig {
    postgresUrl: string;
  }

  export function createDatabaseAdapter(
    config: DatabaseAdapterConfig,
    agentId: UUID,
  ): IDatabaseAdapter;
}
