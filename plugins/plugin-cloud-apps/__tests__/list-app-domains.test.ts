/**
 * LIST_APP_DOMAINS tests — read-only domain inventory per app.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  captureCallback,
  FakeElizaCloudClient,
  installTestProjectRegistry,
  keyedRuntime,
  makeApp,
  makeMessage,
  resetSdk,
  setGetApp,
  setListAppDomains,
  type TestProjectRegistry,
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
let registry: TestProjectRegistry;

function installProjects(
  entries: Array<{ name: string; cloudAppId?: string }>,
  activeIndex?: number | null,
): void {
  registry?.cleanup();
  registry = installTestProjectRegistry(entries, { activeIndex });
}

beforeEach(() => {
  resetSdk();
  installProjects([{ name: "Acme Bot", cloudAppId: APP.id }]);
  setGetApp((id) =>
    Promise.resolve({
      success: true,
      app: id === OTHER.id ? OTHER : APP,
    }),
  );
});

afterEach(() => registry.cleanup());

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

  it("refuses to guess when several Projects exist without an active one", async () => {
    installProjects([
      { name: "Acme Bot", cloudAppId: APP.id },
      { name: "Other Project", cloudAppId: OTHER.id },
    ]);
    const runtime = keyedRuntime();
    const result = await listAppDomainsAction.handler?.(
      runtime,
      makeMessage("what domains do I have?"),
      undefined,
      undefined,
      undefined,
    );
    expect(result?.success).toBe(false);
    expect(result?.data?.reason).toBe("no_active");
    expect(result?.userFacingText).toContain("Select an active project");
  });

  it("says there are no registered Projects when the registry is empty", async () => {
    installProjects([]);
    const runtime = keyedRuntime();
    const result = await listAppDomainsAction.handler?.(
      runtime,
      makeMessage("what domains do I have?"),
      undefined,
      undefined,
      undefined,
    );
    expect(result?.success).toBe(false);
    expect(result?.data?.reason).toBe("no_projects");
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
