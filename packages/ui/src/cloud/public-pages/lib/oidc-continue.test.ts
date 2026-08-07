/**
 * Destination resolution for the OIDC sign-in bounce. Pure functions, no DOM.
 *
 * The property under test is that `/oidc/continue` can only ever navigate to a
 * host this table names. It is reachable by anyone who can link to it, so a
 * caller-influenced destination would make it an open redirect.
 */

import { describe, expect, it } from "vitest";

import { buildOidcResumeUrl, resolveOidcIssuerOrigin } from "./oidc-continue";

const RID = `eoq_${"a".repeat(64)}`;

describe("resolveOidcIssuerOrigin", () => {
  it("keeps a staging console on the staging API host", () => {
    for (const host of [
      "staging.elizacloud.ai",
      "app-staging.elizacloud.ai",
      "api-staging.elizacloud.ai",
      "anything.staging.elizacloud.ai",
    ]) {
      expect(resolveOidcIssuerOrigin(host)).toBe(
        "https://api-staging.elizacloud.ai",
      );
    }
  });

  it("resolves production and every unknown host to the production API host", () => {
    for (const host of [
      "elizacloud.ai",
      "www.elizacloud.ai",
      "app.elizacloud.ai",
      "",
      null,
    ]) {
      expect(resolveOidcIssuerOrigin(host)).toBe("https://api.elizacloud.ai");
    }
  });

  it("uses the current origin in local development, where the dev server proxies /api", () => {
    expect(resolveOidcIssuerOrigin("localhost", "http://localhost:5173")).toBe(
      "http://localhost:5173",
    );
  });

  it("never lets a staging session resume against production", () => {
    // A staging console resuming on the prod issuer would cross tenants and
    // sessions; #15161 is the same class of bug for the app origin.
    expect(resolveOidcIssuerOrigin("staging.elizacloud.ai")).not.toBe(
      "https://api.elizacloud.ai",
    );
  });
});

describe("buildOidcResumeUrl", () => {
  it("builds an absolute resume URL carrying the request id", () => {
    const url = buildOidcResumeUrl(RID, "elizacloud.ai");
    expect(url).toBe(
      `https://api.elizacloud.ai/api/oidc/authorize/resume?rid=${RID}`,
    );
  });

  it("refuses a missing or malformed request id rather than navigating", () => {
    for (const rid of [
      null,
      undefined,
      "",
      "eoq_short",
      `eoq_${"A".repeat(64)}`,
      `eoc_${"a".repeat(64)}`,
      `${"a".repeat(64)}`,
      "../../evil",
    ]) {
      expect(buildOidcResumeUrl(rid, "elizacloud.ai")).toBeNull();
    }
  });

  it("cannot be steered to another origin by the request id", () => {
    // Even a value shaped like a URL is rejected by the id pattern, so the
    // destination host is always the one the table chose.
    expect(
      buildOidcResumeUrl("https://evil.example/x", "elizacloud.ai"),
    ).toBeNull();
    const url = buildOidcResumeUrl(RID, "elizacloud.ai") as string;
    expect(new URL(url).origin).toBe("https://api.elizacloud.ai");
  });
});
