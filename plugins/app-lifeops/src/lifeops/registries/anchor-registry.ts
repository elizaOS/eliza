/**
 * Canonical AnchorRegistry binding for app-lifeops.
 *
 * The `AnchorRegistry` interface itself + the in-memory factory live in
 * `../scheduled-task/consolidation-policy.ts`. This module:
 *   1. Re-exports the canonical type + factory so app-lifeops has a single
 *      `registries/anchor-registry.ts` import surface.
 *   2. Adds per-runtime registration (mirrors `connectorRegistry`) so
 *      consumers like `plugin-health` can call
 *      `getAnchorRegistry(runtime).register(...)`.
 *   3. Registers the built-in calendar / time-window anchors
 *      (`meeting.ended`, `morning.start`, `lunch.start`, `night.start`).
 *
 * `wake.observed`, `wake.confirmed`, `bedtime.target`, `nap.start` are
 * registered by `@elizaos/plugin-health` against this same registry through
 * its `registerHealthAnchors(runtime)` entry point.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type { AnchorRegistry } from "../scheduled-task/consolidation-policy.js";
import type {
  AnchorContext,
  AnchorContribution,
} from "../scheduled-task/types.js";

export type { AnchorRegistry } from "../scheduled-task/consolidation-policy.js";
export { createAnchorRegistry } from "../scheduled-task/consolidation-policy.js";
export type {
  AnchorContext,
  AnchorContribution,
} from "../scheduled-task/types.js";

// Built-in anchor contributions (calendar + time windows).

function nullableTimeAnchor(args: {
  anchorKey: string;
  label: string;
  windowKey: "morningWindow" | "eveningWindow";
  edge: "start" | "end";
}): AnchorContribution {
  const { anchorKey, label, windowKey, edge } = args;
  return {
    anchorKey,
    describe: {
      label,
      provider: "@elizaos/app-lifeops:time-window",
    },
    resolve(context: AnchorContext) {
      const tz = context.ownerFacts.timezone ?? "UTC";
      const window = context.ownerFacts[windowKey];
      const value = edge === "start" ? window?.start : window?.end;
      if (!value) return null;
      return resolveLocalHHMM(context.nowIso, value, tz);
    },
  };
}

function resolveLocalHHMM(
  nowIso: string,
  hhmm: string,
  tz: string,
): { atIso: string } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!match) return null;
  const hour = Number.parseInt(match[1] ?? "0", 10);
  const minute = Number.parseInt(match[2] ?? "0", 10);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date(nowIso));
  const y = Number.parseInt(
    parts.find((p) => p.type === "year")?.value ?? "1970",
    10,
  );
  const mo = Number.parseInt(
    parts.find((p) => p.type === "month")?.value ?? "01",
    10,
  );
  const d = Number.parseInt(
    parts.find((p) => p.type === "day")?.value ?? "01",
    10,
  );
  const localDate = new Date(Date.UTC(y, mo - 1, d, hour, minute, 0));
  const offsetFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "longOffset",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const tzParts = offsetFormatter.formatToParts(localDate);
  const offsetStr =
    tzParts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const offsetMatch = /GMT([+-]\d{1,2})(?::?(\d{2}))?/.exec(offsetStr);
  let offsetMinutes = 0;
  if (offsetMatch) {
    const sign = offsetMatch[1]?.startsWith("-") ? -1 : 1;
    const oh = Math.abs(Number.parseInt(offsetMatch[1] ?? "0", 10));
    const om = Number.parseInt(offsetMatch[2] ?? "0", 10);
    offsetMinutes = sign * (oh * 60 + om);
  }
  const atMs = localDate.getTime() - offsetMinutes * 60_000;
  return { atIso: new Date(atMs).toISOString() };
}

const morningStartAnchor: AnchorContribution = nullableTimeAnchor({
  anchorKey: "morning.start",
  label: "Owner morning window start (ownerFact.morningWindow.start)",
  windowKey: "morningWindow",
  edge: "start",
});

const nightStartAnchor: AnchorContribution = nullableTimeAnchor({
  anchorKey: "night.start",
  label:
    "Owner evening / wind-down window start (ownerFact.eveningWindow.start)",
  windowKey: "eveningWindow",
  edge: "start",
});

/**
 * `lunch.start` — local 12:00 in the owner's timezone. There is no
 * `lunchWindow` field on `OwnerFactsView`; this default approximates what
 * the planner currently assumes when scheduling lunch-time prompts.
 */
const lunchStartAnchor: AnchorContribution = {
  anchorKey: "lunch.start",
  describe: {
    label: "Owner lunch window start (default 12:00 local)",
    provider: "@elizaos/app-lifeops:time-window",
  },
  resolve(context) {
    const tz = context.ownerFacts.timezone ?? "UTC";
    return resolveLocalHHMM(context.nowIso, "12:00", tz);
  },
};

/**
 * `meeting.ended` — the next concrete resolution time isn't known until a
 * meeting fires (event-driven, not time-driven). The anchor returns `null`
 * here; the calendar emitter publishes a bus event that the runner picks up
 * via `trigger.kind = "event"`. The anchor entry exists so the registry
 * lists `meeting.ended` as a known anchor for diagnostics + plan validation.
 */
const meetingEndedAnchor: AnchorContribution = {
  anchorKey: "meeting.ended",
  describe: {
    label: "Calendar meeting ended (event-driven; resolves via bus)",
    provider: "@elizaos/app-lifeops:calendar",
  },
  resolve() {
    return null;
  },
};

export const APP_LIFEOPS_ANCHORS: readonly AnchorContribution[] = [
  morningStartAnchor,
  lunchStartAnchor,
  nightStartAnchor,
  meetingEndedAnchor,
];

/**
 * Register the built-in calendar / time-window anchors. Idempotent via
 * `override: true` so repeated calls (e.g. test setup) don't throw.
 */
export function registerAppLifeOpsAnchors(registry: AnchorRegistry): void {
  for (const anchor of APP_LIFEOPS_ANCHORS) {
    registry.register(anchor, { override: true });
  }
}

// ---------------------------------------------------------------------------
// Per-runtime registration
// ---------------------------------------------------------------------------

const registries = new WeakMap<IAgentRuntime, AnchorRegistry>();

export function registerAnchorRegistry(
  runtime: IAgentRuntime,
  registry: AnchorRegistry,
): void {
  registries.set(runtime, registry);
}

export function getAnchorRegistry(
  runtime: IAgentRuntime,
): AnchorRegistry | null {
  return registries.get(runtime) ?? null;
}

export function __resetAnchorRegistryForTests(runtime: IAgentRuntime): void {
  registries.delete(runtime);
}
