/**
 * Module augmentation interfaces for @babylon/sim.
 *
 * Systems extend these via declaration merging to get typed config keys,
 * service tokens, shared data, and custom hooks — all resolved at the
 * call site without casting.
 *
 * Usage from a system file:
 *
 * ```ts
 * declare module '@babylon/sim' {
 *   interface BabylonConfig {
 *     mySystem: { apiKey: string; retries?: number };
 *   }
 *   interface BabylonServices {
 *     feedCache: Map<string, unknown>;
 *   }
 *   interface BabylonSharedData {
 *     feedReady: boolean;
 *   }
 * }
 * ```
 *
 * This follows the same pattern as Nuxt's `RuntimeConfig`, Nitro's
 * `NitroRuntimeHooks`, and hookable's typed `HookKeys`.
 */

export interface BabylonConfig {}

export interface BabylonServices {}

export interface BabylonSharedData {}

export interface BabylonHooks {}
