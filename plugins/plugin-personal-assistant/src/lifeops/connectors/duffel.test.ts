import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDuffelConnectorContribution } from "./duffel.js";

const duffelMocks = vi.hoisted(() => {
  class MockDuffelConfigError extends Error {}
  return { MockDuffelConfigError, searchFlights: vi.fn() };
});

vi.mock("@elizaos/plugin-elizacloud/cloud/duffel-client", () => ({
  DuffelConfigError: duffelMocks.MockDuffelConfigError,
  readDuffelConfigFromEnv: () => {
    if (
      process.env.ELIZA_DUFFEL_DIRECT === "1" &&
      !process.env.DUFFEL_API_KEY?.trim()
    ) {
      throw new duffelMocks.MockDuffelConfigError(
        "DUFFEL_API_KEY is required for direct Duffel mode.",
      );
    }
    return {
      mode: process.env.ELIZA_DUFFEL_DIRECT === "1" ? "direct" : "cloud",
    };
  },
  searchFlights: duffelMocks.searchFlights,
}));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.ELIZA_DUFFEL_DIRECT = "1";
  delete process.env.DUFFEL_API_KEY;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("createDuffelConnectorContribution", () => {
  it("surfaces missing direct-mode credentials as disconnected status", async () => {
    const connector = createDuffelConnectorContribution({} as IAgentRuntime);

    await expect(connector.verify()).resolves.toBe(false);
    await expect(connector.status()).resolves.toMatchObject({
      state: "disconnected",
      message: expect.stringContaining("DUFFEL_API_KEY"),
    });
  });

  it("refuses outbound send because Duffel is read/search only", async () => {
    const connector = createDuffelConnectorContribution({} as IAgentRuntime);

    await expect(
      connector.send?.({ target: "traveler", message: "book this" }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "transport_error",
      userActionable: false,
      message: expect.stringContaining("does not support outbound send"),
    });
  });

  it("rejects flight searches with missing fields before reading credentials", async () => {
    const connector = createDuffelConnectorContribution({} as IAgentRuntime);

    await expect(
      connector.read?.({
        origin: "LAX",
        destination: "JFK",
      }),
    ).rejects.toThrow(/departureDate/);
  });
});
