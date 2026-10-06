/** The capability wall stays closed for Eliza and opens relay/scheduling/concierge for Network turns. */

import { describe, expect, test } from "bun:test";
import {
  buildSharedCapabilityCatalog,
  formatSharedCapabilityCatalogForPrompt,
} from "./shared-capability-catalog";
import {
  NETWORK_CAPABILITY_WALL_FLAGS,
  resolveSharedCapabilityIntent,
  resolveSharedCapabilityWall,
} from "./shared-capability-wall";

const RELAY = "text Sam I'm in";
const SCHEDULE = "reschedule our meeting to Friday";
const CONCIERGE = "book a table for dinner with Ada";

describe("Shared capability wall: Network flags", () => {
  test("Eliza (no Network flags) still blocks relay, scheduling and concierge", () => {
    const eliza = { reminders: true, todos: true };
    expect(resolveSharedCapabilityWall(RELAY, eliza)?.capability).toBe("communications");
    expect(resolveSharedCapabilityWall(SCHEDULE, eliza)?.capability).toBe("calendar");
    expect(resolveSharedCapabilityWall(CONCIERGE, eliza)?.capability).toBe("bookings");
    expect(resolveSharedCapabilityIntent(RELAY, eliza)?.kind).toBe("blocked-primary");
  });

  test("Network flags let the same intents through as enabled primaries", () => {
    const network = { reminders: true, todos: true, ...NETWORK_CAPABILITY_WALL_FLAGS };
    for (const [message, capability] of [
      [RELAY, "communications"],
      [SCHEDULE, "calendar"],
      [CONCIERGE, "bookings"],
    ] as const) {
      expect(resolveSharedCapabilityWall(message, network)).toBeNull();
      expect(resolveSharedCapabilityIntent(message, network)).toEqual({
        kind: "enabled-primary",
        primary: expect.objectContaining({ capability }),
        blockedSecondary: [],
      });
    }
  });

  test("Network flags do not open unrelated walls", () => {
    const network = { ...NETWORK_CAPABILITY_WALL_FLAGS };
    expect(resolveSharedCapabilityWall("order a pizza for me", network)?.capability).toBe(
      "purchases",
    );
    // A blocked second clause is still reported after an enabled relay.
    const resolution = resolveSharedCapabilityIntent(`${RELAY}, then order a pizza`, network);
    expect(resolution?.kind).toBe("enabled-primary");
    expect(
      resolution?.kind === "enabled-primary"
        ? resolution.blockedSecondary.map((wall) => wall.capability)
        : [],
    ).toEqual(["purchases"]);
  });

  test("the prompt catalog describes Network relay as available, not as needing a workspace", () => {
    const base = { webSearch: false, reminders: false, todos: false, media: false } as const;
    const eliza = formatSharedCapabilityCatalogForPrompt(
      buildSharedCapabilityCatalog({ ...base, transport: "sms" }),
    );
    const network = formatSharedCapabilityCatalogForPrompt(
      buildSharedCapabilityCatalog({
        ...base,
        transport: "sms",
        network: NETWORK_CAPABILITY_WALL_FLAGS,
      }),
    );
    expect(eliza).toContain(
      "Email, calls, and messages (communications); availability: needs workspace",
    );
    expect(network).toContain(
      "Relay a message to another Network member (communications); availability: available",
    );
    expect(network).toContain(
      "Schedule time with another Network member (calendar); availability: available",
    );
    expect(network).toContain("Network concierge search (bookings); availability: available");
    expect(network).not.toContain("(communications); availability: needs workspace");
    // Every other workspace capability is unchanged.
    expect(network).toContain("Purchases (purchases); availability: needs workspace");
    const ids = buildSharedCapabilityCatalog({
      ...base,
      network: NETWORK_CAPABILITY_WALL_FLAGS,
    }).capabilities.map((capability) => capability.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
