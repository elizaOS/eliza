/**
 * Module augmentation interfaces for @feed/sim.
 *
 * Systems extend these via declaration merging to get typed config keys,
 * service tokens, shared data, and custom hooks — all resolved at the
 * call site without casting.
 *
 * Usage from a system file:
 *
 * ```ts
 * declare module '@feed/sim' {
 *   interface FeedConfig {
 *     mySystem: { apiKey: string; retries?: number };
 *   }
 *   interface FeedServices {
 *     feedCache: Map<string, unknown>;
 *   }
 *   interface FeedSharedData {
 *     feedReady: boolean;
 *   }
 * }
 * ```
 *
 * This follows the same pattern as Nuxt's `RuntimeConfig`, Nitro's
 * `NitroRuntimeHooks`, and hookable's typed `HookKeys`.
 */

export type FeedConfig = {};

export type FeedServices = {};

export type FeedSharedData = {};

export type FeedHooks = {};
