/**
 * Covers the hasLifeOpsAccess owner gate: denying on a missing runtime/agentId or message
 * entityId, and otherwise delegating to hasOwnerAccess. Deterministic, mocked owner-access.
 */
import type { Memory } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors the @elizaos/agent owner-access mock other PA action tests use.
// `vi.hoisted` so the mock fn exists when the hoisted `vi.mock` factory runs.
const mocks = vi.hoisted(() => ({
  hasOwnerAccess: vi.fn(async () => true),
}));
vi.mock("@elizaos/agent", () => ({
  hasOwnerAccess: mocks.hasOwnerAccess,
}));

import {
  calendarReadUnavailableMessage,
  calendarWriteUnavailableMessage,
  getGoogleCapabilityStatus,
  gmailReadUnavailableMessage,
  gmailSendUnavailableMessage,
  hasLifeOpsAccess,
} from "../src/lifeops/access.js";
import type { LifeOpsService } from "../src/lifeops/service.js";

type RuntimeArg = Parameters<typeof hasLifeOpsAccess>[0];

// No default params: passing `undefined` must set the field to undefined (a
// default would mask the missing-field guard the tests exercise).
function runtime(agentId: unknown): RuntimeArg {
  return { agentId } as unknown as RuntimeArg;
}
function message(entityId: unknown): Memory {
  return { entityId } as unknown as Memory;
}

function serviceWith(
  connected: boolean,
  grantedCapabilities: string[],
): LifeOpsService {
  return {
    getGoogleConnectorStatus: async () =>
      ({ connected, grantedCapabilities }) as never,
  } as unknown as LifeOpsService;
}

function throwingService(): LifeOpsService {
  return {
    getGoogleConnectorStatus: async () => {
      throw new Error("connector unavailable");
    },
  } as unknown as LifeOpsService;
}

beforeEach(() => {
  mocks.hasOwnerAccess.mockReset().mockResolvedValue(true);
});

describe("hasLifeOpsAccess — owner gate", () => {
  it("denies when runtime/agentId is missing", async () => {
    expect(
      await hasLifeOpsAccess(null as unknown as RuntimeArg, message("owner-1")),
    ).toBe(false);
    expect(await hasLifeOpsAccess(runtime(undefined), message("owner-1"))).toBe(
      false,
    );
    expect(mocks.hasOwnerAccess).not.toHaveBeenCalled();
  });

  it("denies when the message entityId is missing or empty", async () => {
    expect(await hasLifeOpsAccess(runtime("agent-1"), message(undefined))).toBe(
      false,
    );
    expect(await hasLifeOpsAccess(runtime("agent-1"), message(""))).toBe(false);
    expect(mocks.hasOwnerAccess).not.toHaveBeenCalled();
  });

  it("delegates to hasOwnerAccess for a well-formed owner request", async () => {
    mocks.hasOwnerAccess.mockResolvedValueOnce(true);
    expect(await hasLifeOpsAccess(runtime("agent-1"), message("owner-1"))).toBe(
      true,
    );
    mocks.hasOwnerAccess.mockResolvedValueOnce(false);
    expect(await hasLifeOpsAccess(runtime("agent-1"), message("owner-1"))).toBe(
      false,
    );
    expect(mocks.hasOwnerAccess).toHaveBeenCalledTimes(2);
  });
});

describe("getGoogleCapabilityStatus — OAuth grant/scope matrix", () => {
  it("maps calendar write as also granting read", async () => {
    const g = await getGoogleCapabilityStatus(
      serviceWith(true, ["google.calendar.write"]),
    );
    expect(g.connected).toBe(true);
    expect(g.hasCalendarWrite).toBe(true);
    expect(g.hasCalendarRead).toBe(true);
  });

  it("grants read without write when only the read scope is present", async () => {
    const g = await getGoogleCapabilityStatus(
      serviceWith(true, ["google.calendar.read"]),
    );
    expect(g.hasCalendarRead).toBe(true);
    expect(g.hasCalendarWrite).toBe(false);
  });

  it("denies every capability when no scopes are granted", async () => {
    const g = await getGoogleCapabilityStatus(serviceWith(true, []));
    expect(g.hasCalendarRead).toBe(false);
    expect(g.hasCalendarWrite).toBe(false);
    expect(g.hasGmailTriage).toBe(false);
    expect(g.hasGmailSend).toBe(false);
    expect(g.hasGmailManage).toBe(false);
  });

  it("maps each gmail scope independently", async () => {
    const g = await getGoogleCapabilityStatus(
      serviceWith(true, ["google.gmail.triage", "google.gmail.send"]),
    );
    expect(g.hasGmailTriage).toBe(true);
    expect(g.hasGmailSend).toBe(true);
    expect(g.hasGmailManage).toBe(false);
  });

  it("returns a fully-denied snapshot when the connector errors (revoked/unavailable)", async () => {
    const g = await getGoogleCapabilityStatus(throwingService());
    expect(g.status).toBeNull();
    expect(g.connected).toBe(false);
    expect(g.hasCalendarRead).toBe(false);
    expect(g.hasGmailSend).toBe(false);
  });

  it("reflects the connector's connected flag", async () => {
    const g = await getGoogleCapabilityStatus(serviceWith(false, []));
    expect(g.connected).toBe(false);
  });
});

describe("unavailable-message helpers", () => {
  const connected = {
    connected: true,
  } as Parameters<typeof calendarReadUnavailableMessage>[0];
  const disconnected = {
    connected: false,
  } as Parameters<typeof calendarReadUnavailableMessage>[0];

  it("distinguishes limited-access from not-connected wording", () => {
    expect(calendarReadUnavailableMessage(connected)).toMatch(/limited/i);
    expect(calendarReadUnavailableMessage(disconnected)).toMatch(
      /not connected/i,
    );
    expect(calendarWriteUnavailableMessage(connected)).toMatch(/not granted/i);
    expect(calendarWriteUnavailableMessage(disconnected)).toMatch(
      /not connected/i,
    );
    expect(gmailReadUnavailableMessage(connected)).toMatch(/limited/i);
    expect(gmailReadUnavailableMessage(disconnected)).toMatch(/not connected/i);
    expect(gmailSendUnavailableMessage(connected)).toMatch(/not granted/i);
    expect(gmailSendUnavailableMessage(disconnected)).toMatch(/not connected/i);
  });
});
