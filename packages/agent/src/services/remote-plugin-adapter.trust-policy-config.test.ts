/**
 * Pins fail-closed parsing of the capability-router trust policy settings.
 * A malformed ELIZA_CAPABILITY_ROUTER_TRUST_POLICY or
 * ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES must throw instead of silently
 * dropping signature requirements or the module allowlist; unset settings
 * keep the default endpoint-only policy.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RemotePluginTrustPolicyConfigError,
  resolveConfiguredRemotePluginTrustPolicy,
} from "./remote-plugin-adapter.ts";

const ENV_KEYS = [
  "ELIZA_CAPABILITY_ROUTER_URL",
  "ELIZA_REMOTE_CAPABILITY_URL",
  "ELIZA_CAPABILITY_ROUTER_URLS",
  "ELIZA_CAPABILITY_ROUTER_TOKEN",
  "ELIZA_CAPABILITY_ROUTER_ENABLED",
  "ELIZA_REMOTE_CAPABILITY_ENABLED",
  "ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES",
  "ELIZA_CAPABILITY_ROUTER_TRUST_POLICY",
] as const;

function runtimeWith(settings: Record<string, string>): IAgentRuntime {
  return {
    getSetting: (key: string) => settings[key] ?? null,
  } as unknown as IAgentRuntime;
}

const base = { ELIZA_CAPABILITY_ROUTER_URL: "https://router.example.test" };

describe("resolveConfiguredRemotePluginTrustPolicy", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("keeps the default endpoint-only policy when settings are unset", () => {
    expect(resolveConfiguredRemotePluginTrustPolicy(runtimeWith(base))).toEqual(
      { allowedEndpointIds: ["primary"], requireEndpointId: true },
    );
  });

  it("applies well-formed trust policy and module allowlist", () => {
    const policy = resolveConfiguredRemotePluginTrustPolicy(
      runtimeWith({
        ...base,
        ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES: '["mod-a"]',
        ELIZA_CAPABILITY_ROUTER_TRUST_POLICY:
          '{"requireVerifiedProvenance":true}',
      }),
    );
    expect(policy).toMatchObject({
      allowedModuleIds: ["mod-a"],
      requireSignedProvenance: true,
      requireVerifiedProvenance: true,
    });
  });

  it.each([
    ["not json", "{requireVerifiedProvenance:true"],
    ["array", '["requireVerifiedProvenance"]'],
    ["scalar", "true"],
  ])("throws on a malformed trust policy (%s)", (_label, value) => {
    const run = () =>
      resolveConfiguredRemotePluginTrustPolicy(
        runtimeWith({ ...base, ELIZA_CAPABILITY_ROUTER_TRUST_POLICY: value }),
      );
    expect(run).toThrow(RemotePluginTrustPolicyConfigError);
    expect(run).toThrow(/ELIZA_CAPABILITY_ROUTER_TRUST_POLICY/);
  });

  it.each([
    ["not json", '["mod-a"'],
    ["scalar", '"mod-a"'],
    ["null", "null"],
  ])("throws on a malformed module allowlist (%s)", (_label, value) => {
    const run = () =>
      resolveConfiguredRemotePluginTrustPolicy(
        runtimeWith({
          ...base,
          ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES: value,
        }),
      );
    expect(run).toThrow(RemotePluginTrustPolicyConfigError);
    expect(run).toThrow(/ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES/);
  });

  it("throws on a malformed policy supplied through the environment", () => {
    process.env.ELIZA_CAPABILITY_ROUTER_TRUST_POLICY = "{oops";
    expect(() =>
      resolveConfiguredRemotePluginTrustPolicy(runtimeWith(base)),
    ).toThrow(RemotePluginTrustPolicyConfigError);
  });
});
