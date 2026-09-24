/**
 * Pins the canonical account-limit resolvers shared by read snapshots and
 * create-time admission, including corrupt persisted/configured boundaries.
 */

import { describe, expect, test } from "bun:test";
import { ElizaError } from "@elizaos/core";
import {
  getMaxNonTerminalAgentsForOrg,
  resolveMaxNonTerminalAgentsForOrg,
} from "./agent-sandbox-quota";
import {
  getMaxCloudCharactersForOrg,
  resolveMaxCloudCharactersForOrg,
} from "./cloud-character-quota";
import { getMaxContainersForOrg, resolveMaxContainersForOrg } from "./pricing";

function expectTypedFailure(operation: () => unknown, code: string): ElizaError {
  try {
    operation();
  } catch (error) {
    // error-policy:J4 — the test harness captures only the expected typed
    // configuration/source failure so it can assert the stable machine code.
    expect(error).toBeInstanceOf(ElizaError);
    expect((error as ElizaError).code).toBe(code);
    return error as ElizaError;
  }
  throw new Error(`Expected ${code} failure`);
}

describe("Cloud character quota resolver", () => {
  test("reports the authoritative override or balance-tier source", () => {
    expect(resolveMaxCloudCharactersForOrg(0, { max_agents: 7 })).toEqual({
      limit: 7,
      source: "organization.settings.max_agents",
    });
    expect(resolveMaxCloudCharactersForOrg(10, {})).toEqual({
      limit: 100,
      source: "organizations.credit_balance",
    });
  });

  test("keeps a finite negative balance in the free tier", () => {
    expect(getMaxCloudCharactersForOrg(-0.01, {})).toBe(5);
  });

  test("fails closed on every supplied non-finite or non-number balance", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, "10", null]) {
      expectTypedFailure(
        () => getMaxCloudCharactersForOrg(value, {}),
        "INVALID_CLOUD_CHARACTER_QUOTA_SOURCE",
      );
    }
    expectTypedFailure(
      () => getMaxCloudCharactersForOrg(Number.NaN, { max_agents: 7 }),
      "INVALID_CLOUD_CHARACTER_QUOTA_SOURCE",
    );
  });

  test("fails closed on malformed settings and max_agents overrides", () => {
    for (const settings of [
      null,
      [],
      "settings",
      { max_agents: 0 },
      { max_agents: 1.5 },
      { max_agents: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expectTypedFailure(
        () => getMaxCloudCharactersForOrg(10, settings),
        "INVALID_CLOUD_CHARACTER_QUOTA_SOURCE",
      );
    }
  });
});

describe("Agent sandbox quota resolver", () => {
  test("keeps undefined as the documented non-eager free cap", () => {
    expect(resolveMaxNonTerminalAgentsForOrg(undefined)).toEqual({
      limit: 5,
      source: "default_free_tier",
    });
  });

  test("keeps a finite negative balance in the free tier", () => {
    expect(getMaxNonTerminalAgentsForOrg(-1)).toBe(5);
  });

  test("fails closed on every supplied non-finite or non-number balance", () => {
    for (const value of [Number.NaN, Number.NEGATIVE_INFINITY, "10", null]) {
      expectTypedFailure(
        () => getMaxNonTerminalAgentsForOrg(value),
        "INVALID_AGENT_SANDBOX_QUOTA_SOURCE",
      );
    }
  });
});

describe("Container quota resolver", () => {
  test("reports the authoritative override or balance-tier source", () => {
    expect(resolveMaxContainersForOrg(0, { max_containers: 8 })).toEqual({
      limit: 8,
      source: "organization_config.settings.max_containers",
    });
    expect(resolveMaxContainersForOrg(100, {})).toEqual({
      limit: 100,
      source: "organizations.credit_balance",
    });
  });

  test("keeps a finite negative balance in the free tier", () => {
    expect(getMaxContainersForOrg(-1, {})).toBe(1);
  });

  test("distinguishes a missing balance from corrupt source values", () => {
    expectTypedFailure(
      () => getMaxContainersForOrg(undefined, {}),
      "MISSING_CONTAINER_QUOTA_SOURCE",
    );
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, "100"]) {
      expectTypedFailure(() => getMaxContainersForOrg(value, {}), "INVALID_CONTAINER_QUOTA_SOURCE");
    }
  });

  test("fails closed on malformed settings and max_containers overrides", () => {
    for (const settings of [
      null,
      [],
      "settings",
      { max_containers: 0 },
      { max_containers: 2.5 },
      { max_containers: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expectTypedFailure(
        () => getMaxContainersForOrg(10, settings),
        "INVALID_CONTAINER_QUOTA_SOURCE",
      );
    }
    expectTypedFailure(
      () => getMaxContainersForOrg(Number.NaN, { max_containers: 8 }),
      "INVALID_CONTAINER_QUOTA_SOURCE",
    );
  });
});
