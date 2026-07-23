/**
 * Exercises attached-domain status reads through the real action and a fake
 * SDK boundary, including live, stored, ambiguous, and failed responses.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  FakeElizaCloudClient,
  installTestProjectRegistry,
  keyedRuntime,
  makeApp,
  makeMessage,
  resetSdk,
  setGetApp,
  setGetAppDomainStatus,
  type TestProjectRegistry,
  unkeyedRuntime,
} from "./helpers";

mock.module("@elizaos/cloud-sdk", () => ({
  ElizaCloudClient: FakeElizaCloudClient,
}));
const { getAppDomainStatusAction } = await import(
  "../src/actions/get-app-domain-status.ts"
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

describe("GET_APP_DOMAIN_STATUS", () => {
  it("validates only when Cloud credentials are configured", async () => {
    expect(
      await getAppDomainStatusAction.validate?.(
        keyedRuntime(),
        makeMessage("x"),
      ),
    ).toBe(true);
    expect(
      await getAppDomainStatusAction.validate?.(
        unkeyedRuntime(),
        makeMessage("x"),
      ),
    ).toBe(false);
  });

  it("reads exact app/domain status and reports live registrar progress", async () => {
    let received: { appId: string; input: { domain: string } } | undefined;
    setGetAppDomainStatus((appId, input) => {
      received = { appId, input };
      return Promise.resolve({
        success: true,
        domain: "coolbrand.com",
        registrar: "cloudflare",
        status: "active",
        verified: true,
        sslStatus: "active",
        expiresAt: "2027-07-01T00:00:00.000Z",
        live: {
          status: "active",
          completedAt: "2026-07-23T12:00:00.000Z",
          failureReason: null,
        },
      });
    });

    const result = await getAppDomainStatusAction.handler?.(
      keyedRuntime(),
      makeMessage("did coolbrand.com get bought for Acme Bot?"),
      undefined,
      {
        parameters: { domain: "COOLBRAND.COM", appName: "Acme Bot" },
      },
    );

    expect(received).toEqual({
      appId: APP.id,
      input: { domain: "coolbrand.com" },
    });
    expect(result?.success).toBe(true);
    expect(result?.verifiedUserFacing).toBe(true);
    expect(result?.userFacingText).toContain("Live registrar status: active");
    expect(result?.userFacingText).toContain("completed 2026-07-23");
    expect(result?.data).toMatchObject({
      domain: "coolbrand.com",
      registrar: "cloudflare",
      status: "active",
      verified: true,
      sslStatus: "active",
    });
  });

  it("distinguishes stored external-domain state from a live registrar read", async () => {
    setGetAppDomainStatus((_appId, input) =>
      Promise.resolve({
        success: true,
        domain: input.domain,
        registrar: "external",
        status: "pending",
        verified: false,
        sslStatus: null,
        expiresAt: null,
        live: null,
      }),
    );

    const result = await getAppDomainStatusAction.handler?.(
      keyedRuntime(),
      makeMessage("is example.org verified yet?"),
      undefined,
      { domain: "example.org" },
    );

    expect(result?.success).toBe(true);
    expect(result?.userFacingText).toContain("not verified");
    expect(result?.userFacingText).toContain("SSL status unavailable");
    expect(result?.userFacingText).toContain(
      "Live registrar polling does not apply",
    );
    expect(result?.data?.sslStatus).toBeNull();
  });

  it("requires exactly one domain", async () => {
    const missing = await getAppDomainStatusAction.handler?.(
      keyedRuntime(),
      makeMessage("is my domain ready?"),
    );
    expect(missing?.success).toBe(false);
    expect(missing?.data?.reason).toBe("no_domain");

    const ambiguous = await getAppDomainStatusAction.handler?.(
      keyedRuntime(),
      makeMessage("compare first.example and second.example"),
    );
    expect(ambiguous?.success).toBe(false);
    expect(ambiguous?.data?.reason).toBe("ambiguous_domain");
    expect(ambiguous?.data?.candidates).toEqual([
      "first.example",
      "second.example",
    ]);
  });

  it("refuses to guess when several Projects exist without an active one", async () => {
    installProjects([
      { name: "Acme Bot", cloudAppId: APP.id },
      { name: "Other Project", cloudAppId: OTHER.id },
    ]);

    const result = await getAppDomainStatusAction.handler?.(
      keyedRuntime(),
      makeMessage("is example.org active?"),
    );

    expect(result?.success).toBe(false);
    expect(result?.data?.reason).toBe("no_active");
    expect(result?.userFacingText).toContain("Select an active project");
  });

  it("reports missing credentials and an empty Project registry honestly", async () => {
    const noKey = await getAppDomainStatusAction.handler?.(
      unkeyedRuntime(),
      makeMessage("is example.org active?"),
    );
    expect(noKey?.success).toBe(false);
    expect(noKey?.data?.reason).toBe("no_key");

    installProjects([]);
    const noProjects = await getAppDomainStatusAction.handler?.(
      keyedRuntime(),
      makeMessage("is example.org active?"),
    );
    expect(noProjects?.success).toBe(false);
    expect(noProjects?.data?.reason).toBe("no_projects");
  });

  it("returns an error state for transport failures or malformed success data", async () => {
    setGetAppDomainStatus(() => Promise.reject(new Error("offline")));
    const transport = await getAppDomainStatusAction.handler?.(
      keyedRuntime(),
      makeMessage("is example.org active?"),
    );
    expect(transport?.success).toBe(false);
    expect(transport?.data?.reason).toBe("error");

    setGetAppDomainStatus((_appId, input) =>
      Promise.resolve({
        success: true,
        domain: input.domain,
      }),
    );
    const malformed = await getAppDomainStatusAction.handler?.(
      keyedRuntime(),
      makeMessage("is example.org active?"),
    );
    expect(malformed?.success).toBe(false);
    expect(malformed?.data?.reason).toBe("error");
  });
});
