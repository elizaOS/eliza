import type { Plugin } from "@elizaos/core";

/**
 * `@elizaos/plugin-scheduling` — the scheduling spine.
 *
 * During the LifeOps decomposition this package owns the storage-agnostic
 * ScheduledTask state machine (types, runner, registries, due/next-fire-at
 * math, anchors) and the spine→reminders ports. Persistence and the
 * owner/channel/connector dependencies are INJECTED by the host
 * (`@elizaos/plugin-personal-assistant`), which remains the registrar of the
 * runner service + the SCHEDULED_TASKS action during the decomposition. This
 * Plugin object is exported for standalone use; the runtime first-wins dedup
 * prevents double-registration when PA also registers the spine.
 *
 * See `plugins/plugin-personal-assistant/docs/lifeops-extraction-plan.md`.
 */
export const schedulingPlugin: Plugin = {
  name: "@elizaos/plugin-scheduling",
  description:
    "Scheduling spine: the storage-agnostic ScheduledTask state machine + registries + runner. Persistence and owner/channel deps are injected by the host.",
};
