/**
 * calendlyEventTypes provider tests.
 *
 * Guards #12744 (#12275-G fallback-slop sweep): a Calendly API/auth/network
 * failure inside the provider `get()` must render the designed J4 degrade
 * line — distinguishable from the not-connected empty state — and surface the
 * underlying error via `runtime.reportError` so it is observable in
 * RECENT_ERRORS / owner-escalation instead of being silently swallowed.
 */
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { CALENDLY_SERVICE_TYPE } from "../types.js";
import { calendlyEventTypesProvider } from "./calendly-event-types.js";

const message = { id: "m", content: { text: "" } } as unknown as Memory;
const state = {} as State;

function runtimeWith(
  service: Record<string, unknown> | undefined,
  reportError = vi.fn(),
): IAgentRuntime {
  return {
    getSetting: vi.fn(() => undefined),
    getService: vi.fn((name: string) =>
      name === CALENDLY_SERVICE_TYPE ? service : undefined,
    ),
    reportError,
  } as unknown as IAgentRuntime;
}

describe("calendlyEventTypes provider", () => {
  it("returns the designed not-connected state without reporting", async () => {
    const reportError = vi.fn();
    const result = await calendlyEventTypesProvider.get(
      runtimeWith({ isConnected: vi.fn(() => false) }, reportError),
      message,
      state,
    );
    expect(result.text).toBe("");
    expect(result.values).toMatchObject({ calendlyConnected: false });
    expect(reportError).not.toHaveBeenCalled();
  });

  it("lists active event types on success", async () => {
    const service = {
      isConnected: vi.fn(() => true),
      listEventTypes: vi.fn(async () => [
        {
          uri: "https://api.calendly.com/event_types/1",
          name: "Intro Call",
          slug: "intro-call",
          duration: 30,
          scheduling_url: "https://calendly.com/me/intro-call",
          active: true,
          kind: "solo",
          type: "StandardEventType",
        },
        {
          uri: "https://api.calendly.com/event_types/2",
          name: "Retired",
          slug: "retired",
          duration: 15,
          scheduling_url: "https://calendly.com/me/retired",
          active: false,
          kind: "solo",
          type: "StandardEventType",
        },
      ]),
    };
    const result = await calendlyEventTypesProvider.get(
      runtimeWith(service),
      message,
      state,
    );
    expect(result.text).toContain("Intro Call");
    expect(result.text).not.toContain("Retired");
    expect(result.values).toMatchObject({
      calendlyConnected: true,
      eventTypeCount: 1,
    });
  });

  it("renders the J4 degrade and reports when the Calendly read fails", async () => {
    const boom = new Error("Calendly API 503");
    const reportError = vi.fn();
    const service = {
      isConnected: vi.fn(() => true),
      listEventTypes: vi.fn(async () => {
        throw boom;
      }),
    };

    const result = await calendlyEventTypesProvider.get(
      runtimeWith(service, reportError),
      message,
      state,
    );

    // NOT the designed not-connected empty text: a broken Calendly read must
    // be distinguishable from "not connected / nothing to show".
    expect(result.text).toBe("Error retrieving Calendly event types");
    expect(result.values).toMatchObject({
      calendlyConnected: true,
      calendlyError: "Calendly API 503",
    });
    expect(result.data).toMatchObject({ error: "Calendly API 503" });
    // The failure is observable in RECENT_ERRORS / owner-escalation.
    expect(reportError).toHaveBeenCalledWith(
      "calendlyEventTypes.provider",
      boom,
    );
  });
});
