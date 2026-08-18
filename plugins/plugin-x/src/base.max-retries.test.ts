/**
 * Deterministic unit coverage for the authentication retry-budget resolver:
 * MAX_RETRIES values that are non-numeric, zero, or negative must fall back to
 * the default instead of producing a NaN/non-positive budget that both skips
 * the authenticate loop and defeats its failure guard.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./client/accounts", () => ({
  resolveRequestedXAccountId: (
    _runtime: unknown,
    _state: unknown,
    accountId: string | undefined,
  ) => accountId ?? "default",
  resolveTwitterAccountConfig: async (
    _runtime: unknown,
    options: { state: unknown },
  ) => options.state,
}));

vi.mock("./client/auth-providers/factory", () => ({
  createTwitterAuthProvider: () => ({}),
}));

import { ClientBase, resolveMaxAuthRetries, type TwitterProfile } from "./base";
import type { TwitterClientState } from "./types";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("resolveMaxAuthRetries", () => {
  it("defaults to 3 when MAX_RETRIES is unset or whitespace-only", () => {
    expect(resolveMaxAuthRetries(undefined)).toBe(3);
    expect(resolveMaxAuthRetries("")).toBe(3);
    expect(resolveMaxAuthRetries(" \t\n ")).toBe(3);
  });

  it("accepts canonical positive safe integers with surrounding env whitespace", () => {
    expect(resolveMaxAuthRetries("1")).toBe(1);
    expect(resolveMaxAuthRetries("5")).toBe(5);
    expect(resolveMaxAuthRetries(" 10 ")).toBe(10);
    expect(resolveMaxAuthRetries(String(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("rejects non-canonical decimal, exponent, sign, prefix, and suffix forms", () => {
    for (const raw of [
      "2.9",
      "1.0",
      ".5",
      "1e3",
      "+2",
      "01",
      "0x10",
      "5junk",
      "5n",
    ]) {
      expect(resolveMaxAuthRetries(raw)).toBe(3);
    }
  });

  it("rejects zero, negatives, non-numbers, and unsafe integers", () => {
    for (const raw of [
      "0",
      "-1",
      "-100",
      "abc",
      "NaN",
      "Infinity",
      String(Number.MAX_SAFE_INTEGER + 1),
      "9".repeat(400),
    ]) {
      expect(resolveMaxAuthRetries(raw)).toBe(3);
    }
  });

  it("routes malformed budgets through the real init authentication call", async () => {
    const profile: TwitterProfile = {
      id: "account-1",
      username: "agent",
      screenName: "Agent",
      bio: "",
      nicknames: [],
    };

    for (const raw of ["abc", "2.9", "1e3", "5junk", "0", "-1"]) {
      vi.stubEnv("MAX_RETRIES", raw);
      const authenticate = vi.fn(async () => {});
      const isLoggedIn = vi.fn(async () => true);
      const client = new ClientBase(
        {
          agentId: "agent-1",
          character: { name: "Agent" },
          getSetting: () => undefined,
        } as unknown as IAgentRuntime,
        { accountId: "default" } as TwitterClientState,
      );
      client.twitterClient = {
        authenticate,
        isLoggedIn,
      } as unknown as ClientBase["twitterClient"];
      Object.assign(client, {
        getAuthenticatedProfile: vi.fn(async () => profile),
        populateTimeline: vi.fn(async () => {}),
      });

      await client.init();

      expect(authenticate, raw).toHaveBeenCalledOnce();
      expect(isLoggedIn, raw).toHaveBeenCalledOnce();
      vi.unstubAllEnvs();
    }
  });
});
