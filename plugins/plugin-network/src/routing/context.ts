/**
 * The `network` routing context. Stage 1 only offers contexts that are
 * registered in `runtime.contexts` AND backed by an authorized action or
 * provider (plugin-assistant context-catalog.ts); without this definition the
 * model never sees "network" and routes availability messages to
 * simple/general, where SET_STATE is not discoverable.
 */
import type { ContextDefinition } from "@elizaos/core";

export const NETWORK_CONTEXT_DEFINITION: ContextDefinition = {
  id: "network",
  label: "The Network",
  description:
    "The member's Network membership: pausing or resuming introductions, being busy or traveling (in another city until a date), " +
    "how often The Network contacts them, and their Network profile and active introductions.",
  descriptionCompressed:
    "Network availability: pause/resume intros, busy, traveling until a date",
  sensitivity: "personal",
};
