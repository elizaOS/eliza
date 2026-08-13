// @vitest-environment jsdom

/**
 * Host-trust policy coverage focused on the strict iOS (store / cloud-runtime)
 * network policy — specifically that canonical eliza.app shared-tier hosts are
 * trusted even when `cloudApiBase` is not pinned to them. Under jsdom
 * `window.location.hostname` is "localhost", so trust here comes purely from
 * the shared-host predicate, not the current-origin allowance.
 */

import { describe, expect, it } from "vitest";
import {
  createUrlTrustPolicy,
  isElizaCloudSharedHost,
} from "../src/url-trust-policy";

function strictStorePolicy(cloudApiBase?: string) {
  return createUrlTrustPolicy({
    isNative: true,
    isIOS: true,
    isStoreBuild: true,
    cloudApiBase,
    isPopoutWindow: false,
    getIosRuntimeMode: () => "cloud",
  });
}

describe("isElizaCloudSharedHost", () => {
  it("matches the canonical shared-tier control-plane hosts (case-insensitive)", () => {
    expect(isElizaCloudSharedHost("eliza.app")).toBe(true);
    expect(isElizaCloudSharedHost("cloud.eliza.app")).toBe(true);
    expect(isElizaCloudSharedHost("API.eliza.app")).toBe(true);
    expect(isElizaCloudSharedHost("api-staging.eliza.app")).toBe(true);
  });

  it("keeps redirect-era control planes trusted but excludes agent and arbitrary hosts", () => {
    expect(isElizaCloudSharedHost("elizacloud.ai")).toBe(true);
    expect(isElizaCloudSharedHost("api.elizacloud.ai")).toBe(true);
    expect(isElizaCloudSharedHost("agent-123.cloud.eliza.app")).toBe(false);
    expect(isElizaCloudSharedHost("agent-123.elizacloud.ai")).toBe(false);
    expect(isElizaCloudSharedHost("evil.com")).toBe(false);
    expect(isElizaCloudSharedHost("eliza.app.evil.com")).toBe(false);
  });
});

describe("strict iOS policy — shared-tier bootstrap", () => {
  it("trusts the shared apex + api hosts even when cloudApiBase is not pinned", () => {
    const policy = strictStorePolicy(undefined);
    expect(
      policy.isTrustedApiBaseUrl(
        new URL("https://cloud.eliza.app/api/v1/eliza/agents/agent-1"),
      ),
    ).toBe(true);
    expect(
      policy.isTrustedApiBaseUrl(
        new URL("https://api.eliza.app/api/v1/eliza/agents/agent-1"),
      ),
    ).toBe(true);
  });

  it("still rejects http:// and private/loopback hosts under the strict policy", () => {
    const policy = strictStorePolicy(undefined);
    expect(policy.isTrustedApiBaseUrl(new URL("http://eliza.app/api"))).toBe(
      false,
    );
    expect(policy.isTrustedApiBaseUrl(new URL("https://127.0.0.1/api"))).toBe(
      false,
    );
    expect(policy.isTrustedApiBaseUrl(new URL("https://192.168.1.5/api"))).toBe(
      false,
    );
  });

  it("still rejects an arbitrary public https host (no blanket cloud trust)", () => {
    const policy = strictStorePolicy(undefined);
    expect(policy.isTrustedApiBaseUrl(new URL("https://evil.com/api"))).toBe(
      false,
    );
  });

  it("also trusts the shared hosts on the deep-link gateway path", () => {
    const policy = strictStorePolicy(undefined);
    expect(
      policy.isTrustedDeepLinkApiBaseUrl(new URL("https://api.eliza.app/api")),
    ).toBe(true);
    expect(
      policy.isTrustedDeepLinkApiBaseUrl(new URL("https://evil.com/api")),
    ).toBe(false);
  });
});
