import type { LifeOpsCalendarEvent } from "@elizaos/contracts";

export type EventEditorReadOnlyReason =
  | "provider_version_missing"
  | "microsoft_read_only"
  | "ics_subscription"
  | "apple_read_only";

export type EventEditorMutability =
  | { readonly kind: "editable"; readonly providerVersion: string }
  | { readonly kind: "read_only"; readonly reason: EventEditorReadOnlyReason };

/**
 * Which edit affordances the owner-editor mutation pipeline can actually
 * honor for this event. The pipeline (client → route → owner-editor gateway →
 * trusted executor) performs etag-conditional writes and supports them only
 * for Google and built-in Eliza events; Microsoft mutations, ICS subscription
 * feeds, and the Apple native bridge are rejected server-side. Rendering a
 * Save/Delete button for those events would dead-end on every click, so the
 * drawer derives its affordances from this capability instead.
 */
export function eventEditorMutability(
  event: LifeOpsCalendarEvent,
): EventEditorMutability {
  switch (event.provider) {
    case "google":
    case "eliza": {
      const etag = event.metadata.etag;
      return typeof etag === "string" && etag.trim().length > 0
        ? { kind: "editable", providerVersion: etag.trim() }
        : { kind: "read_only", reason: "provider_version_missing" };
    }
    case "microsoft":
      return { kind: "read_only", reason: "microsoft_read_only" };
    case "ics":
      return { kind: "read_only", reason: "ics_subscription" };
    case "apple_calendar":
      return { kind: "read_only", reason: "apple_read_only" };
  }
}

/**
 * Mirrors the approval executor's organizer-disposition rules
 * (plugin-personal-assistant lifeops-port `eventOrganizerDisposition`): the
 * drawer must never offer a cancellation mode the executor would reject.
 * Organizer identity may also arrive only as the organizer email matching the
 * owning account email, so that comparison is part of the contract.
 * `remove_private_copy` is executor-gated to invitee disposition; the drawer's
 * single delete affordance maps invitees to `decline_invitation`.
 */
export function cancellationModeForEditorEvent(
  event: LifeOpsCalendarEvent,
): "organizer_cancel" | "decline_invitation" | null {
  if (event.organizer?.self === true) return "organizer_cancel";
  const selfAttendee = event.attendees.find((attendee) => attendee.self);
  if (selfAttendee) {
    return selfAttendee.organizer ? "organizer_cancel" : "decline_invitation";
  }
  const organizerEmail =
    typeof event.organizer?.email === "string"
      ? event.organizer.email.trim().toLowerCase()
      : null;
  const accountEmail = event.accountEmail?.trim().toLowerCase() || null;
  if (organizerEmail && accountEmail && organizerEmail === accountEmail) {
    return "organizer_cancel";
  }
  return null;
}
