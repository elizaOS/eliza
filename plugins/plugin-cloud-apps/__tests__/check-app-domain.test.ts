/**
 * CHECK_APP_DOMAIN tests — read-only availability + price quotes.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { CheckAppDomainInput } from "@elizaos/cloud-sdk";
import {
  captureCallback,
  FakeElizaCloudClient,
  keyedRuntime,
  makeApp,
  makeMessage,
  resetSdk,
  setCheckAppDomain,
  setListApps,
  unkeyedRuntime,
} from "./helpers";

mock.module("@elizaos/cloud-sdk", () => ({
  ElizaCloudClient: FakeElizaCloudClient,
}));
const { checkAppDomainAction } = await import(
  "../src/actions/check-app-domain.ts"
);

const APP = makeApp({ name: "Acme Bot", slug: "acme-bot" });
const OTHER = makeApp({
  id: "00000000-0000-0000-0000-000000000002",
  name: "Other App",
  slug: "other-app",
});

function trackChecks() {
  const calls: Array<{ id: string; input: CheckAppDomainInput }> = [];
  setCheckAppDomain((id, input) => {
    calls.push({ id, input });
    return Promise.resolve({
      success: true,
      domain: input.domain,
      available: true,
      currency: "USD",
      years: 1,
      price: {
        wholesaleUsdCents: 1029,
        marginUsdCents: 370,
        totalUsdCents: 1399,
        marginBps: 3600,
      },
      renewal: { totalUsdCents: 1499 },
    });
  });
  return { calls };
}

beforeEach(() => {
  resetSdk();
  setListApps(() => Promise.resolve({ success: true, apps: [APP] }));
});

describe("CHECK_APP_DOMAIN", () => {
  it("validate is true with a key, false without", async () => {
    expect(
      await checkAppDomainAction.validate?.(keyedRuntime(), makeMessage("x")),
    ).toBe(true);
    expect(
      await checkAppDomainAction.validate?.(unkeyedRuntime(), makeMessage("x")),
    ).toBe(false);
  });

  it("quotes an available domain with purchase + renewal price", async () => {
    const runtime = keyedRuntime();
    trackChecks();
    const { fn, calls: replies } = captureCallback();
    const result = await checkAppDomainAction.handler?.(
      runtime,
      makeMessage("is example.com available?"),
      undefined,
      undefined,
      fn,
    );
    expect(result?.success).toBe(true);
    const text = replies[0]?.text ?? "";
    expect(text).toContain("example.com is available");
    expect(text).toContain("$13.99/yr");
    expect(text).toContain("renews at $14.99/yr");
  });

  it("reports a taken domain honestly", async () => {
    setCheckAppDomain((_id, input) =>
      Promise.resolve({
        success: true,
        domain: input.domain,
        available: false,
      }),
    );
    const runtime = keyedRuntime();
    const result = await checkAppDomainAction.handler?.(
      runtime,
      makeMessage("is example.com available?"),
      undefined,
      undefined,
      undefined,
    );
    expect(result?.success).toBe(true);
    expect(result?.userFacingText).toContain("not available");
  });

  it("checks several domains in one ask, capped at three with an honest note", async () => {
    const runtime = keyedRuntime();
    const { calls } = trackChecks();
    const result = await checkAppDomainAction.handler?.(
      runtime,
      makeMessage("check a-one.com, b-two.com, c-three.com and d-four.com"),
      undefined,
      undefined,
      undefined,
    );
    expect(calls.length).toBe(3);
    expect(result?.userFacingText).toContain("I checked the first 3");
  });

  it("falls back to any app for the quote when no reference matches (app-agnostic)", async () => {
    setListApps(() => Promise.resolve({ success: true, apps: [APP, OTHER] }));
    const runtime = keyedRuntime();
    const { calls } = trackChecks();
    const result = await checkAppDomainAction.handler?.(
      runtime,
      makeMessage("is example.com available?"),
      undefined,
      undefined,
      undefined,
    );
    expect(result?.success).toBe(true);
    expect(calls[0]?.id).toBe(APP.id);
  });

  it("asks for a domain when none is named", async () => {
    const runtime = keyedRuntime();
    const result = await checkAppDomainAction.handler?.(
      runtime,
      makeMessage("can you check a domain for me"),
      undefined,
      undefined,
      undefined,
    );
    expect(result?.success).toBe(false);
    expect(result?.data?.reason).toBe("no_domain");
  });

  it("explains that domains need an app when the user has none", async () => {
    setListApps(() => Promise.resolve({ success: true, apps: [] }));
    const runtime = keyedRuntime();
    const result = await checkAppDomainAction.handler?.(
      runtime,
      makeMessage("is example.com available?"),
      undefined,
      undefined,
      undefined,
    );
    expect(result?.success).toBe(false);
    expect(result?.data?.reason).toBe("no_apps");
  });

  it("returns an honest generic error when the check API fails", async () => {
    setCheckAppDomain(() => Promise.reject(new Error("boom")));
    const runtime = keyedRuntime();
    const result = await checkAppDomainAction.handler?.(
      runtime,
      makeMessage("is example.com available?"),
      undefined,
      undefined,
      undefined,
    );
    expect(result?.success).toBe(false);
    expect(result?.data?.reason).toBe("error");
  });
});

describe("CHECK_APP_DOMAIN remaining exits", () => {
  it("degrades gracefully with no API key", async () => {
    const result = await checkAppDomainAction.handler?.(
      unkeyedRuntime(),
      makeMessage("is example.com available?"),
      undefined,
      undefined,
      undefined,
    );
    expect(result?.success).toBe(false);
    expect(result?.data?.reason).toBe("no_key");
  });

  it("keeps partial results when one of several checks fails", async () => {
    setCheckAppDomain((_id, input) => {
      if (input.domain === "b-two.com") {
        return Promise.reject(new Error("boom"));
      }
      return Promise.resolve({
        success: true,
        domain: input.domain,
        available: true,
        currency: "USD",
        years: 1,
        price: {
          wholesaleUsdCents: 1029,
          marginUsdCents: 370,
          totalUsdCents: 1399,
          marginBps: 3600,
        },
        renewal: { totalUsdCents: 1399 },
      });
    });
    const runtime = keyedRuntime();
    const result = await checkAppDomainAction.handler?.(
      runtime,
      makeMessage("check a-one.com and b-two.com"),
      undefined,
      undefined,
      undefined,
    );
    expect(result?.success).toBe(true);
    expect(result?.userFacingText).toContain("a-one.com is available");
    expect(result?.userFacingText).toContain("Couldn't check b-two.com");
    expect(result?.data?.failed).toEqual(["b-two.com"]);
  });
});
