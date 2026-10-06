/**
 * Invite gate for The Network's inbound messaging route.
 *
 * The personal-shared route auto-creates a Cloud account for any phone that
 * texts a configured number. For project `network` that must not happen: only a
 * phone with a live or accepted invite (or an existing member) may reach account
 * resolution and a model turn. Everyone else gets one polite canned reply and
 * nothing is written. Group chats are not a Network surface and are dropped
 * silently, so no compliance or invite copy is ever posted into a group.
 *
 * The invite store is injected so the route stays testable and the gate never
 * imports a database client at module load.
 */

import { NETWORK_PERSONAL_SHARED_PROJECT } from "../services/shared-runtime/personal-shared-identity";

export const NETWORK_INVITE_REQUIRED_REPLY =
  "Hi, this is The Network. It's invite-only right now, and we don't have an invite for this number. " +
  "If someone invited you, open the invite link they sent from this phone. Reply STOP to opt out.";

/** Looks up invite/membership state for an inbound address. */
export interface NetworkInviteLookup {
  /**
   * True when the address has a live (pending, unexpired) or accepted invite,
   * or already belongs to a
   * non-removed member. Must not create or mutate anything.
   */
  isInvitedOrMember(input: { channel: "phone"; address: string }): Promise<boolean>;
}

/** Minimal inbound shape the gate inspects (a subset of the route's parsed payload). */
export type NetworkInboundMessage =
  | { project?: string; platform: "twilio" | "blooio"; phoneNumber: string; chatType?: undefined }
  | { project?: string; platform: string; chatType: string }
  | { project?: string; platform: string; chatType?: undefined };

export type NetworkInboundGateDecision =
  | { kind: "allow" }
  | { kind: "reply"; code: "network_invite_required"; reply: string }
  | { kind: "drop"; code: "network_group_unsupported" | "network_channel_unsupported" };

export function isNetworkProject(project: string | undefined | null): boolean {
  return project?.trim().toLowerCase() === NETWORK_PERSONAL_SHARED_PROJECT;
}

/**
 * Decide whether a `network` inbound message may proceed to account
 * resolution. Messages for any other project always return `allow` without
 * touching the lookup, so Eliza behaviour is unchanged.
 */
export async function evaluateNetworkInboundGate(
  message: NetworkInboundMessage,
  lookup: NetworkInviteLookup,
): Promise<NetworkInboundGateDecision> {
  if (!isNetworkProject(message.project)) return { kind: "allow" };
  if (message.chatType !== undefined) {
    return { kind: "drop", code: "network_group_unsupported" };
  }
  if (
    (message.platform !== "twilio" && message.platform !== "blooio") ||
    !("phoneNumber" in message)
  ) {
    // The Network is phone-addressed. A Telegram DM has no verified phone to
    // check an invite against, so it is refused without an account.
    return {
      kind: "reply",
      code: "network_invite_required",
      reply: NETWORK_INVITE_REQUIRED_REPLY,
    };
  }
  const invited = await lookup.isInvitedOrMember({
    channel: "phone",
    address: message.phoneNumber,
  });
  return invited
    ? { kind: "allow" }
    : {
        kind: "reply",
        code: "network_invite_required",
        reply: NETWORK_INVITE_REQUIRED_REPLY,
      };
}

/** Test/simulator store: invited phones. */
export class InMemoryNetworkInviteStore implements NetworkInviteLookup {
  readonly lookups: string[] = [];
  readonly #accepted = new Set<string>();

  constructor(acceptedPhones: Iterable<string> = []) {
    for (const phone of acceptedPhones) this.#accepted.add(phone);
  }

  accept(phone: string): void {
    this.#accepted.add(phone);
  }

  async isInvitedOrMember(input: { channel: "phone"; address: string }): Promise<boolean> {
    this.lookups.push(input.address);
    return this.#accepted.has(input.address);
  }
}
