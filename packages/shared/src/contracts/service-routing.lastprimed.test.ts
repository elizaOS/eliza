/**
 * Regression tests for `lastPrimedAt` handling in the shared linked-account
 * record normalizer (#16482). The auto-priming feature persists a probe
 * attempt timestamp on the record; the normalizer must round-trip finite
 * epoch values and drop non-finite/typed-wrong ones, and the rest of the
 * fail-closed record semantics must be unaffected by the new optional field.
 */
import { describe, expect, it } from "vitest";
import {
  buildDefaultElizaCloudServiceRouting,
  buildElizaCloudServiceRoute,
  normalizeDeploymentTargetConfig,
  normalizeLinkedAccountRecord,
  normalizeLinkedAccountsRecords,
  normalizeServiceRouteConfig,
  normalizeServiceRoutingConfig,
} from "./service-routing.js";

const baseRecord = {
  id: "acct-1",
  providerId: "anthropic-subscription",
  label: "Primary",
  source: "oauth",
  enabled: true,
  priority: 1,
  createdAt: 1_700_000_000_000,
  health: "ok",
} as const;

describe("normalizeLinkedAccountRecord lastPrimedAt", () => {
  it("preserves a finite lastPrimedAt epoch value", () => {
    const normalized = normalizeLinkedAccountRecord({
      ...baseRecord,
      lastPrimedAt: 1_700_000_123_456,
    });
    expect(normalized).not.toBeNull();
    expect(normalized?.lastPrimedAt).toBe(1_700_000_123_456);
  });

  it("omits lastPrimedAt when absent", () => {
    const normalized = normalizeLinkedAccountRecord({ ...baseRecord });
    expect(normalized).not.toBeNull();
    expect(normalized).not.toHaveProperty("lastPrimedAt");
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["string", "1700000123456"],
    ["null", null],
    ["object", { at: 1 }],
  ])("drops non-finite/non-number lastPrimedAt (%s)", (_name, value) => {
    const normalized = normalizeLinkedAccountRecord({
      ...baseRecord,
      lastPrimedAt: value,
    });
    expect(normalized).not.toBeNull();
    expect(normalized).not.toHaveProperty("lastPrimedAt");
  });

  it("keeps lastPrimedAt independent of lastUsedAt", () => {
    const normalized = normalizeLinkedAccountRecord({
      ...baseRecord,
      lastUsedAt: 1_700_000_000_111,
      lastPrimedAt: 1_700_000_000_222,
    });
    expect(normalized?.lastUsedAt).toBe(1_700_000_000_111);
    expect(normalized?.lastPrimedAt).toBe(1_700_000_000_222);
  });

  it("still fail-closes records missing required fields", () => {
    expect(
      normalizeLinkedAccountRecord({
        ...baseRecord,
        id: "",
        lastPrimedAt: 1_700_000_123_456,
      }),
    ).toBeNull();
  });

  it("round-trips lastPrimedAt through normalizeLinkedAccountsRecords", () => {
    const records = normalizeLinkedAccountsRecords({
      "acct-1": { ...baseRecord, lastPrimedAt: 1_700_000_123_456 },
    });
    expect(records?.["acct-1"]?.lastPrimedAt).toBe(1_700_000_123_456);
  });
});

// The priming feature reads billing header to find subscription-backed
// accounts; pin the surrounding route/routing normalizers so a regression
// in this module cannot silently strip the fields priming relies on.
describe("service route/routing normalizers around priming config", () => {
  it("normalizes a full route config and dedupes accountIds", () => {
    const route = normalizeServiceRouteConfig({
      backend: " anthropic ",
      transport: "direct",
      accountId: "acct-1",
      accountIds: ["acct-1", " acct-2 ", "acct-1", "", 7],
      strategy: "quota-aware",
      primaryModel: "claude-sonnet",
      largeModel: " claude-opus ",
      remoteApiBase: "https://example.test",
    });
    expect(route).toEqual({
      backend: "anthropic",
      transport: "direct",
      accountId: "acct-1",
      accountIds: ["acct-1", "acct-2"],
      strategy: "quota-aware",
      primaryModel: "claude-sonnet",
      largeModel: "claude-opus",
      remoteApiBase: "https://example.test",
    });
  });

  it("returns null for empty or non-record route configs", () => {
    expect(normalizeServiceRouteConfig(null)).toBeNull();
    expect(normalizeServiceRouteConfig("llmText")).toBeNull();
    expect(normalizeServiceRouteConfig({})).toBeNull();
    expect(
      normalizeServiceRouteConfig({ transport: "bogus", strategy: "nope" }),
    ).toBeNull();
  });

  it("keeps only capabilities with valid route configs", () => {
    const routing = normalizeServiceRoutingConfig({
      llmText: { backend: "anthropic" },
      tts: { transport: "bogus" },
      unknownCapability: { backend: "x" },
    });
    expect(routing).toEqual({ llmText: { backend: "anthropic" } });
    expect(normalizeServiceRoutingConfig({ tts: {} })).toBeNull();
    expect(normalizeServiceRoutingConfig(null)).toBeNull();
  });

  it("builds default cloud routing without clobbering existing routes", () => {
    const base = { tts: { backend: "custom" } };
    const routing = buildDefaultElizaCloudServiceRouting({
      base,
      includeInference: true,
      excludeServices: ["rpc"],
      largeModel: "claude-opus",
    });
    expect(routing.tts).toEqual({ backend: "custom" });
    expect(routing.rpc).toBeUndefined();
    expect(routing.media?.backend).toBe("elizacloud");
    expect(routing.llmText?.largeModel).toBe("claude-opus");
    expect(buildElizaCloudServiceRoute()).toEqual({
      backend: "elizacloud",
      transport: "cloud-proxy",
      accountId: "elizacloud",
    });
  });

  it("normalizes deployment targets fail-closed", () => {
    expect(normalizeDeploymentTargetConfig(null)).toBeNull();
    expect(normalizeDeploymentTargetConfig({ runtime: "bogus" })).toBeNull();
    expect(
      normalizeDeploymentTargetConfig({
        runtime: "remote",
        provider: "remote",
        remoteApiBase: " https://example.test ",
        remoteAccessToken: " tok ",
      }),
    ).toEqual({
      runtime: "remote",
      provider: "remote",
      remoteApiBase: "https://example.test",
      remoteAccessToken: "tok",
    });
  });
});
