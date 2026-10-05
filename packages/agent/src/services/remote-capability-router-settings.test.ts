/**
 * Pins the shared capability-router settings parser the router, the remote
 * plugin trust policy and the connect route all read through: every accepted
 * endpoint-list format resolves, and malformed values throw instead of being
 * reinterpreted.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveRemoteCapabilityRouterConfig } from "./remote-capability-router.ts";
import {
  CapabilityRouterSettingError,
  parseCapabilityRouterEndpointsSetting,
  serializeCapabilityRouterTrustPolicySetting,
} from "./remote-capability-router-settings.ts";

const TRUST_POLICY_FIELD_NAMES = [
  "allowedProvenanceIssuers",
  "trustedProvenancePublicKeys",
  "requireSignedProvenance",
  "requireVerifiedProvenance",
  "requireProvenanceDigestMatch",
] as const;

const ENV_KEYS = [
  "ELIZA_CAPABILITY_ROUTER_URLS",
  "ELIZA_CAPABILITY_ROUTER_TOKEN",
] as const;

function runtimeWith(settings: Record<string, string>) {
  return { getSetting: (key: string) => settings[key] ?? null };
}

describe("resolveRemoteCapabilityRouterConfig endpoint list", () => {
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

  it.each([
    ["comma-separated list", "https://a.example.com/, https://b.example.com"],
    ["string array", '["https://a.example.com","https://b.example.com/"]'],
    [
      "object array",
      '[{"baseUrl":"https://a.example.com"},{"id":"","baseUrl":"https://b.example.com"}]',
    ],
  ])("accepts a %s and applies the default token", (_label, value) => {
    const config = resolveRemoteCapabilityRouterConfig(
      runtimeWith({
        ELIZA_CAPABILITY_ROUTER_URLS: value,
        ELIZA_CAPABILITY_ROUTER_TOKEN: "shared",
      }),
    );
    expect(config.endpoints).toEqual([
      { id: "remote-1", baseUrl: "https://a.example.com", token: "shared" },
      { id: "remote-2", baseUrl: "https://b.example.com", token: "shared" },
    ]);
  });

  it("keeps an entry's own id and token", () => {
    const config = resolveRemoteCapabilityRouterConfig(
      runtimeWith({
        ELIZA_CAPABILITY_ROUTER_URLS:
          '[{"id":"home","baseUrl":"https://a.example.com","token":"own"}]',
        ELIZA_CAPABILITY_ROUTER_TOKEN: "shared",
      }),
    );
    expect(config.endpoints).toEqual([
      { id: "home", baseUrl: "https://a.example.com", token: "own" },
    ]);
  });

  it.each([
    ["broken JSON array", '["https://a.example.com"'],
    ["object", '{"baseUrl":"https://a.example.com"}'],
    ["blank string entry", '[""]'],
    ["non-string entry", '["https://a.example.com",7]'],
    ["entry without baseUrl", '[{"id":"home"}]'],
    ["non-string id", '[{"id":7,"baseUrl":"https://a.example.com"}]'],
    ["non-string token", '[{"baseUrl":"https://a.example.com","token":7}]'],
  ])("throws on a malformed endpoint list (%s)", (_label, value) => {
    const run = () =>
      resolveRemoteCapabilityRouterConfig(
        runtimeWith({ ELIZA_CAPABILITY_ROUTER_URLS: value }),
      );
    expect(run).toThrow(CapabilityRouterSettingError);
    expect(run).toThrow(/ELIZA_CAPABILITY_ROUTER_URLS/);
  });
});

describe("reserved trust-policy field names as endpoint ids", () => {
  it.each(TRUST_POLICY_FIELD_NAMES)(
    "rejects endpoint id %s in the endpoint list",
    (id) => {
      const run = () =>
        parseCapabilityRouterEndpointsSetting(
          JSON.stringify([{ id: ` ${id} `, baseUrl: "https://a.example.com" }]),
        );
      expect(run).toThrow(CapabilityRouterSettingError);
      expect(run).toThrow(/reserved/);
    },
  );

  it.each(TRUST_POLICY_FIELD_NAMES)(
    "refuses to serialize a per-endpoint trust policy keyed %s",
    (id) => {
      expect(() =>
        serializeCapabilityRouterTrustPolicySetting({
          global: {},
          endpoints: { [id]: { requireSignedProvenance: true } },
        }),
      ).toThrow(CapabilityRouterSettingError);
    },
  );
});
