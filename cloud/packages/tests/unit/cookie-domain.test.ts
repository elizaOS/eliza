import { describe, expect, test } from "bun:test";
import { cookieDomainForHost } from "@/lib/auth/cookie-domain";

describe("cookieDomainForHost", () => {
  test("scopes elizacloud.ai apex to parent zone", () => {
    expect(cookieDomainForHost("elizacloud.ai")).toBe("elizacloud.ai");
  });

  test("scopes www.elizacloud.ai to parent zone", () => {
    expect(cookieDomainForHost("www.elizacloud.ai")).toBe("elizacloud.ai");
  });

  test("scopes api.elizacloud.ai to parent zone", () => {
    expect(cookieDomainForHost("api.elizacloud.ai")).toBe("elizacloud.ai");
  });

  test("scopes api-staging.elizacloud.ai to parent zone", () => {
    expect(cookieDomainForHost("api-staging.elizacloud.ai")).toBe(
      "elizacloud.ai",
    );
  });

  test("strips port before matching", () => {
    expect(cookieDomainForHost("www.elizacloud.ai:443")).toBe("elizacloud.ai");
  });

  test("is case-insensitive", () => {
    expect(cookieDomainForHost("WWW.Elizacloud.AI")).toBe("elizacloud.ai");
  });

  test("returns undefined for localhost dev", () => {
    expect(cookieDomainForHost("localhost")).toBeUndefined();
    expect(cookieDomainForHost("localhost:3000")).toBeUndefined();
  });

  test("returns undefined for pages.dev preview hosts", () => {
    expect(
      cookieDomainForHost("335dcc99.eliza-cloud-enq.pages.dev"),
    ).toBeUndefined();
  });

  test("returns undefined for label-prefix attacks", () => {
    // elizacloud.ai.evil.com must not be treated as an elizacloud.ai subdomain
    expect(cookieDomainForHost("elizacloud.ai.evil.com")).toBeUndefined();
    // foo-elizacloud.ai is not a subdomain of elizacloud.ai
    expect(cookieDomainForHost("fooelizacloud.ai")).toBeUndefined();
  });

  test("returns undefined for empty or missing host", () => {
    expect(cookieDomainForHost(undefined)).toBeUndefined();
    expect(cookieDomainForHost("")).toBeUndefined();
  });
});
