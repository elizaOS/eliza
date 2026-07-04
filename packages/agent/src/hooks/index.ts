/**
 * Public barrel for the workspace hook subsystem: re-exports hook discovery
 * (`loadHooks`) and the in-process event registry (`createHookEvent`,
 * `triggerHook`).
 */
export {
  type LoadHooksOptions,
  loadHooks,
} from "./loader.ts";
export {
  createHookEvent,
  triggerHook,
} from "./registry.ts";
