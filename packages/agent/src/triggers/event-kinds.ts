/**
 * Event kinds an automation can subscribe to, in the spelling the Automations
 * form offers and in the spelling the runtime bus emits. The form stores
 * dotted presets such as "message.received"; the bus emits `EventType`
 * values such as "MESSAGE_RECEIVED". Nothing emits a connector-specific
 * message kind, so the Discord and Telegram presets are the bus kind narrowed
 * by the payload's source. A kind outside the presets is matched as given.
 */
import { EventType } from "@elizaos/core";

export interface ResolvedTriggerEventKind {
  kind: string;
  source?: string;
}

const PRESET_EVENT_KINDS: Readonly<Record<string, ResolvedTriggerEventKind>> = {
  "message.received": { kind: EventType.MESSAGE_RECEIVED },
  "discord.message.received": {
    kind: EventType.MESSAGE_RECEIVED,
    source: "discord",
  },
  "telegram.message.received": {
    kind: EventType.MESSAGE_RECEIVED,
    source: "telegram",
  },
};

export function resolveTriggerEventKind(
  eventKind: string,
): ResolvedTriggerEventKind {
  const trimmed = eventKind.trim();
  return PRESET_EVENT_KINDS[trimmed] ?? { kind: trimmed };
}

/** The connector a bus payload came from, lower-cased, or null when unknown. */
export function readEventPayloadSource(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as {
    source?: unknown;
    message?: { content?: { source?: unknown }; source?: unknown };
  };
  const candidates = [
    record.source,
    record.message?.content?.source,
    record.message?.source,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim().toLowerCase();
    }
  }
  return null;
}

/** Whether a trigger's stored event kind subscribes to the given bus event. */
export function triggerEventMatches(
  triggerEventKind: string | undefined,
  event: { kind: string; payload?: unknown },
): boolean {
  if (!triggerEventKind) return false;
  const expected = resolveTriggerEventKind(triggerEventKind);
  const actual = resolveTriggerEventKind(event.kind);
  if (expected.kind !== actual.kind) return false;
  if (!expected.source) return true;
  return (
    (actual.source ?? readEventPayloadSource(event.payload)) === expected.source
  );
}
