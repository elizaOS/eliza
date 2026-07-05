import { afterEach, describe, expect, it, vi } from "vitest";
import { hasStewardAuthedCookie, stewardAuthedCookieName } from "./index";

function stubDocumentCookie(cookie: string): void {
  vi.stubGlobal("document", { cookie });
}

describe("steward session marker cookie", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps production and unset environments on the historical marker", () => {
    expect(stewardAuthedCookieName()).toBe("steward-authed");
    expect(stewardAuthedCookieName("production")).toBe("steward-authed");
  });

  it("suffixes non-production marker cookies by environment", () => {
    expect(stewardAuthedCookieName("staging")).toBe("steward-authed-staging");
    expect(stewardAuthedCookieName("dev")).toBe("steward-authed-dev");
  });

  it("does not let a staging page trust the production marker", () => {
    stubDocumentCookie("steward-authed=1");
    expect(hasStewardAuthedCookie("staging")).toBe(false);

    stubDocumentCookie("steward-authed-staging=1; steward-authed=1");
    expect(hasStewardAuthedCookie("staging")).toBe(true);
  });
});
