// @vitest-environment jsdom

/**
 * Host-trust policy coverage focused on the strict iOS (store / cloud-runtime)
 * network policy — specifically that the canonical Eliza Cloud shared-tier hosts
 * are trusted even when `cloudApiBase` is NOT pinned to them, so the free
 * shared-agent bootstrap (`<host>/api/v1/eliza/agents/<id>`) is not rejected on a
 * store build. Under jsdom `window.location.hostname` is "localhost", so any
 * elizacloud.ai trust here comes purely from the shared-host predicate, not the
 * current-origin allowance.
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
    expect(isElizaCloudSharedHost("elizacloud.ai")).toBe(true);
    expect(isElizaCloudSharedHost("www.elizacloud.ai")).toBe(true);
    expect(isElizaCloudSharedHost("API.elizacloud.ai")).toBe(true);
  });

  it("does not match per-agent subdomains, staging, or arbitrary hosts", () => {
    expect(isElizaCloudSharedHost("agent-123.elizacloud.ai")).toBe(false);
    expect(isElizaCloudSharedHost("staging.elizacloud.ai")).toBe(false);
    expect(isElizaCloudSharedHost("evil.com")).toBe(false);
    expect(isElizaCloudSharedHost("elizacloud.ai.evil.com")).toBe(false);
  });
});

describe("strict iOS policy — shared-tier bootstrap", () => {
  it("trusts the shared apex + api hosts even when cloudApiBase is not pinned", () => {
    const policy = strictStorePolicy(undefined);
    expect(
      policy.isTrustedApiBaseUrl(
        new URL("https://elizacloud.ai/api/v1/eliza/agents/agent-1"),
      ),
    ).toBe(true);
    expect(
      policy.isTrustedApiBaseUrl(
        new URL("https://api.elizacloud.ai/api/v1/eliza/agents/agent-1"),
      ),
    ).toBe(true);
  });

  it("still rejects http:// and private/loopback hosts under the strict policy", () => {
    const policy = strictStorePolicy(undefined);
    expect(
      policy.isTrustedApiBaseUrl(new URL("http://elizacloud.ai/api")),
    ).toBe(false);
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
      policy.isTrustedDeepLinkApiBaseUrl(new URL("https://elizacloud.ai/api")),
    ).toBe(true);
    expect(
      policy.isTrustedDeepLinkApiBaseUrl(new URL("https://evil.com/api")),
    ).toBe(false);
  });
});
