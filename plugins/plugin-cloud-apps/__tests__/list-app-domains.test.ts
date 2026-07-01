/**
 * LIST_APP_DOMAINS tests — read-only domain inventory per app.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
  captureCallback,
  FakeElizaCloudClient,
  keyedRuntime,
  makeApp,
  makeMessage,
  resetSdk,
  setListAppDomains,
  setListApps,
  unkeyedRuntime,
} from "./helpers";

mock.module("@elizaos/cloud-sdk", () => ({
  ElizaCloudClient: FakeElizaCloudClient,
}));
const { listAppDomainsAction } = await import(
  "../src/actions/list-app-domains.ts"
);

const APP = makeApp({ name: "Acme Bot", slug: "acme-bot" });
const OTHER = makeApp({
  id: "00000000-0000-0000-0000-000000000002",
  name: "Other App",
  slug: "other-app",
});

beforeEach(() => {
  resetSdk();
  setListApps(() => Promise.resolve({ success: true, apps: [APP] }));
});

describe("LIST_APP_DOMAINS", () => {
  it("validate is true with a key, false without", async () => {
    expect(
      await listAppDomainsAction.validate?.(keyedRuntime(), makeMessage("x")),
    ).toBe(true);
    expect(
      await listAppDomainsAction.validate?.(unkeyedRuntime(), makeMessage("x")),
    ).toBe(false);
  });

  it("lists domains with registrar, SSL, verification, and renewal", async () => {
    setListAppDomains(() =>
      Promise.resolve({
        success: true,
        domains: [
          {
            id: "ad_1",
            domain: "coolbrand.com",
            registrar: "cloudflare",
            status: "active",
            verified: true,
            sslStatus: "active",
            expiresAt: "2027-07-01T00:00:00.000Z",
            cloudflareZoneId: "zone_1",
            verificationToken: null,
          },
          {
            id: "ad_2",
            domain: "example.org",
            registrar: "external",
            status: "pending",
            verified: false,
            sslStatus: "pending",
            expiresAt: null,
            cloudflareZoneId: null,
            verificationToken: "eliza-verify-abc",
          },
        ],
      }),
    );
    const runtime = keyedRuntime();
    const { fn, calls: replies } = captureCallback();
    const result = await listAppDomainsAction.handler?.(
      runtime,
      makeMessage("what domains does Acme Bot have?"),
      undefined,
      undefined,
      fn,
    );
    expect(result?.success).toBe(true);
    const text = replies[0]?.text ?? "";
    expect(text).toContain("2 domains");
    expect(text).toContain("coolbrand.com");
    expect(text).toContain("renews 2027-07-01");
    expect(text).toContain("_eliza-cloud-verify.example.org");
  });

  it("reports an empty inventory with a next step", async () => {
    const runtime = keyedRuntime();
    const result = await listAppDomainsAction.handler?.(
      runtime,
      makeMessage("list Acme Bot domains"),
      undefined,
      undefined,
      undefined,
    );
    expect(result?.success).toBe(true);
    expect(result?.userFacingText).toContain("no custom domains yet");
  });

  it("defaults to the sole app", async () => {
    const runtime = keyedRuntime();
    const result = await listAppDomainsAction.handler?.(
      runtime,
      makeMessage("what domains do I have?"),
      undefined,
      undefined,
      undefined,
    );
    expect(result?.success).toBe(true);
    expect(result?.userFacingText).toContain("Acme Bot");
  });

  it("asks which app when several exist and none matches", async () => {
    setListApps(() => Promise.resolve({ success: true, apps: [APP, OTHER] }));
    const runtime = keyedRuntime();
    const result = await listAppDomainsAction.handler?.(
      runtime,
      makeMessage("what domains do I have?"),
      undefined,
      undefined,
      undefined,
    );
    expect(result?.success).toBe(false);
    expect(result?.data?.reason).toBe("not_found");
    expect(result?.userFacingText).toContain("Other App");
  });

  it("says there are no apps when the user has none", async () => {
    setListApps(() => Promise.resolve({ success: true, apps: [] }));
    const runtime = keyedRuntime();
    const result = await listAppDomainsAction.handler?.(
      runtime,
      makeMessage("what domains do I have?"),
      undefined,
      undefined,
      undefined,
    );
    expect(result?.success).toBe(false);
    expect(result?.data?.reason).toBe("no_apps");
  });

  it("returns an honest generic error when the API fails", async () => {
    setListAppDomains(() => Promise.reject(new Error("boom")));
    const runtime = keyedRuntime();
    const result = await listAppDomainsAction.handler?.(
      runtime,
      makeMessage("list Acme Bot domains"),
      undefined,
      undefined,
      undefined,
    );
    expect(result?.success).toBe(false);
    expect(result?.data?.reason).toBe("error");
  });
});

describe("LIST_APP_DOMAINS remaining exits", () => {
  it("degrades gracefully with no API key", async () => {
    const result = await listAppDomainsAction.handler?.(
      unkeyedRuntime(),
      makeMessage("list my domains"),
      undefined,
      undefined,
      undefined,
    );
    expect(result?.success).toBe(false);
    expect(result?.data?.reason).toBe("no_key");
  });

  it("surfaces the TXT verification VALUE for an unverified external domain", async () => {
    setListAppDomains(() =>
      Promise.resolve({
        success: true,
        domains: [
          {
            id: "ad_2",
            domain: "example.org",
            registrar: "external",
            status: "pending",
            verified: false,
            sslStatus: "pending",
            expiresAt: null,
            cloudflareZoneId: null,
            verificationToken: "eliza-verify-abc123",
          },
        ],
      }),
    );
    const runtime = keyedRuntime();
    const result = await listAppDomainsAction.handler?.(
      runtime,
      makeMessage("list Acme Bot domains"),
      undefined,
      undefined,
      undefined,
    );
    expect(result?.userFacingText).toContain("eliza-verify-abc123");
  });
});
