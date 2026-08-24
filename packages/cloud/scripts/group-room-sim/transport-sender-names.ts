/**
 * Which connector transports put a human-readable sender name on the inbound
 * event, and what that means for the `speakerAwareness` assertion.
 *
 * This is the one fact the scorer needs that lives outside the homepage
 * script: a group turn can only name a person if the transport told Eliza
 * who was speaking. The cloud API resolves every group speaker through the
 * participant registry
 * (`packages/cloud/api/internal/eliza-app/personal-shared/messages/route.ts`),
 * which stores `actor.displayName` when the connector sent one and otherwise
 * falls back to `Participant <ordinal>`
 * (`groupParticipantLabel` in
 * `packages/cloud/shared/src/lib/services/shared-runtime/group-participant-labels.ts`).
 *
 * Verified against the gateway adapters on develop:
 *   - `adapters/blooio.ts`   never sets `senderName` (iMessage sends none)
 *   - `adapters/telegram.ts` sets `senderName: event.senderName`
 *   - `adapters/twilio.ts`   sets `senderName: event.ProfileName`
 *   - `adapters/whatsapp.ts` sets `senderName` from its contact map
 * The gateway copies that onto `actor.displayName` only when it is present
 * (`webhook-handler.ts`), so a transport missing from the name-carrying side
 * of this table produces ordinal labels and nothing else.
 */

/** Transports the group-room choreography can be scored against. */
export type SimTransport = "blooio" | "telegram" | "twilio" | "whatsapp";

/**
 * True when the transport's adapter sends a display name for the speaker.
 *
 * `Record<SimTransport, boolean>` is exhaustive on purpose: adding a member to
 * {@link SimTransport} is a type error until this table answers the question
 * for it, so a new connector cannot silently inherit either behaviour.
 */
export const TRANSPORT_CARRIES_SENDER_NAMES: Record<SimTransport, boolean> =
  Object.freeze({
    blooio: false,
    telegram: true,
    twilio: true,
    whatsapp: true,
  });

/**
 * The transport the driver actually speaks. `run-room-sim.ts` posts Blooio v4
 * envelopes at the Blooio webhook, so this is a property of the tool, not a
 * user choice; the run loop takes an override only so the tests can score the
 * name-carrying path.
 */
export const DRIVER_TRANSPORT: SimTransport = "blooio";

/** Transports that do send names, for the skip reason's "use one of these". */
export function nameCarryingTransports(): SimTransport[] {
  return (Object.keys(TRANSPORT_CARRIES_SENDER_NAMES) as SimTransport[])
    .filter((t) => TRANSPORT_CARRIES_SENDER_NAMES[t])
    .sort();
}

/**
 * Why `speakerAwareness` did not run. Recorded in the result rather than
 * quietly passing: a check that cannot fail must say so where the verdict is
 * read, or it reads as evidence it never gathered.
 */
export function speakerAwarenessSkipReason(transport: SimTransport): string {
  return (
    `transport "${transport}" sends no display names, so every group speaker ` +
    "is labelled `Participant <ordinal>` and no reply can name a member. " +
    `Scored only on a name-carrying transport (${nameCarryingTransports().join(", ")}).`
  );
}
