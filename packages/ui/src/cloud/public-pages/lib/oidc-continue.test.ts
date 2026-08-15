/**
 * Destination resolution for the OIDC sign-in bounce. Pure functions, no DOM;
 * the build-time issuer is stubbed with `vi.stubEnv`, the way the other
 * `import.meta.env` consumers in this package are tested.
 *
 * Two properties are under test. `/oidc/continue` can only ever navigate to the
 * origin of the issuer this deployment was configured with — it is reachable by
 * anyone who can link to it, so a caller-influenced destination would make it an
 * open redirect. And a deployment that configured no issuer resolves to NOTHING
 * rather than to a guess: the provider answers only on the host its own issuer
 * names, so a wrong guess produces a resume that reports the user's sign-in as
 * expired and no evidence anywhere of why.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildOidcResumeTarget,
  configuredOidcIssuerUrl,
  prepareOidcResumeTarget,
  resolveOidcIssuerOrigin,
} from "./oidc-continue";

const RID = `eoq_${"a".repeat(64)}`;

afterEach(() => {
  vi.unstubAllEnvs();
});

function withIssuer(value: string): void {
  vi.stubEnv("VITE_OIDC_ISSUER_URL", value);
}

describe("resolveOidcIssuerOrigin", () => {
  it("derives the origin from the configured issuer, whatever the console host", () => {
    withIssuer("https://api.elizacloud.ai");
    for (const host of [
      "elizacloud.ai",
      "app.elizacloud.ai",
      "console.internal",
      "",
    ]) {
      expect(resolveOidcIssuerOrigin(host)).toBe("https://api.elizacloud.ai");
    }
  });

  it("keeps a staging console on the issuer staging was built with", () => {
    // The pairing is deployment configuration, not something derivable from the
    // console hostname: a staging session resuming on the prod issuer would
    // cross tenants and sessions.
    withIssuer("https://api-staging.elizacloud.ai");
    expect(resolveOidcIssuerOrigin("staging.elizacloud.ai")).toBe(
      "https://api-staging.elizacloud.ai",
    );
    expect(resolveOidcIssuerOrigin("staging.elizacloud.ai")).not.toBe(
      "https://api.elizacloud.ai",
    );
  });

  it("drops a path on the issuer, because the resume endpoint is served from the root", () => {
    withIssuer("https://api.elizacloud.ai/oidc/");
    expect(resolveOidcIssuerOrigin("elizacloud.ai")).toBe(
      "https://api.elizacloud.ai",
    );
  });

  it("uses the current origin on loopback, where the dev server proxies /api", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      expect(resolveOidcIssuerOrigin(host, `http://${host}:5173`)).toBe(
        `http://${host}:5173`,
      );
    }
  });

  it("prefers an explicitly configured issuer even in local development", () => {
    // The local Worker is a different port from the Vite server, and the
    // provider answers only on the host its issuer names.
    withIssuer("http://127.0.0.1:8787");
    expect(resolveOidcIssuerOrigin("127.0.0.1", "http://127.0.0.1:5173")).toBe(
      "http://127.0.0.1:8787",
    );
  });

  it("resolves NOTHING for an unconfigured non-loopback host", () => {
    // The old behavior — quietly defaulting to the production API host — sent
    // every self-hosted, preview, and custom-domain console to an issuer that
    // has never heard of its parked request.
    expect(configuredOidcIssuerUrl()).toBeUndefined();
    for (const host of ["elizacloud.ai", "console.example", "hub.internal"]) {
      expect(resolveOidcIssuerOrigin(host, `https://${host}`)).toBeNull();
    }
  });

  it("reports an unusable configured value rather than falling back to a guess", () => {
    withIssuer("api.elizacloud.ai");
    expect(resolveOidcIssuerOrigin("elizacloud.ai")).toBeNull();
    expect(
      resolveOidcIssuerOrigin("localhost", "http://localhost:5173"),
    ).toBeNull();
  });

  it.each(["javascript:alert(1)", "data:text/plain,issuer", "file:///api"])(
    "rejects a non-HTTP issuer scheme: %s",
    (issuer) => {
      withIssuer(issuer);
      expect(resolveOidcIssuerOrigin("staging.eliza.app")).toBeNull();
      expect(buildOidcResumeTarget(RID, "staging.eliza.app")).toEqual({
        status: "issuer_unconfigured",
      });
    },
  );

  it("reads only the VITE_ name Vite actually exposes to the bundle", () => {
    // The Next-era name was accepted here as a fallback, but Vite only inlines
    // `VITE_`-prefixed members, so that branch could never fire in a real build
    // — a deployment that set it would silently get the unconfigured screen.
    vi.stubEnv("NEXT_PUBLIC_OIDC_ISSUER_URL", "https://api.elizacloud.ai");
    expect(configuredOidcIssuerUrl()).toBeUndefined();
    expect(resolveOidcIssuerOrigin("elizacloud.ai")).toBeNull();

    withIssuer("https://api.elizacloud.ai");
    expect(configuredOidcIssuerUrl()).toBe("https://api.elizacloud.ai");
  });

  it("trims surrounding whitespace and treats a blank value as unset", () => {
    withIssuer("  https://api.elizacloud.ai  ");
    expect(resolveOidcIssuerOrigin("elizacloud.ai")).toBe(
      "https://api.elizacloud.ai",
    );
    withIssuer("   ");
    expect(configuredOidcIssuerUrl()).toBeUndefined();
    expect(resolveOidcIssuerOrigin("elizacloud.ai")).toBeNull();
  });
});

describe("buildOidcResumeTarget", () => {
  it("builds an absolute resume URL carrying the request id", () => {
    withIssuer("https://api.elizacloud.ai");
    expect(buildOidcResumeTarget(RID, "elizacloud.ai")).toEqual({
      status: "ok",
      url: `https://api.elizacloud.ai/api/oidc/authorize/resume?rid=${RID}`,
    });
  });

  it("refuses a missing or malformed request id rather than navigating", () => {
    withIssuer("https://api.elizacloud.ai");
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
      expect(buildOidcResumeTarget(rid, "elizacloud.ai").status).toBe(
        "invalid_request_id",
      );
    }
  });

  it("cannot be steered to another origin by the request id", () => {
    // Even a value shaped like a URL is rejected by the id pattern, so the
    // destination host is always the configured one.
    withIssuer("https://api.elizacloud.ai");
    expect(
      buildOidcResumeTarget("https://evil.example/x", "elizacloud.ai").status,
    ).toBe("invalid_request_id");
    const target = buildOidcResumeTarget(RID, "elizacloud.ai");
    expect(target.status).toBe("ok");
    expect(new URL(target.status === "ok" ? target.url : "").origin).toBe(
      "https://api.elizacloud.ai",
    );
  });

  it("separates a missing issuer from an expired link so the page can say which", () => {
    expect(
      buildOidcResumeTarget(RID, "console.example", "https://console.example"),
    ).toEqual({
      status: "issuer_unconfigured",
    });
    expect(buildOidcResumeTarget("nope", "console.example").status).toBe(
      "invalid_request_id",
    );
  });
});

describe("prepareOidcResumeTarget", () => {
  it("syncs the stored session to the configured staging issuer before resume", async () => {
    withIssuer("https://api-staging.eliza.app");
    const events: string[] = [];

    const target = await prepareOidcResumeTarget(
      RID,
      "staging.eliza.app",
      "https://staging.eliza.app",
      {
        readToken: () => "  steward-access-token  ",
        syncSession: async (token, endpoint) => {
          events.push(`${token} ${endpoint}`);
        },
      },
    );

    expect(events).toEqual([
      "steward-access-token https://api-staging.eliza.app/api/auth/steward-session",
    ]);
    expect(target).toEqual({
      status: "ok",
      url: `https://api-staging.eliza.app/api/oidc/authorize/resume?rid=${RID}`,
    });
  });

  it("does not sync an invalid request id", async () => {
    withIssuer("https://api-staging.eliza.app");
    const syncSession = vi.fn(() => Promise.resolve());

    await expect(
      prepareOidcResumeTarget("invalid", "staging.eliza.app", undefined, {
        readToken: () => "token",
        syncSession,
      }),
    ).resolves.toEqual({ status: "invalid_request_id" });
    expect(syncSession).not.toHaveBeenCalled();
  });

  it("does not consume the request without a stored Steward session", async () => {
    withIssuer("https://api-staging.eliza.app");
    const syncSession = vi.fn(() => Promise.resolve());

    await expect(
      prepareOidcResumeTarget(RID, "staging.eliza.app", undefined, {
        readToken: () => "  ",
        syncSession,
      }),
    ).resolves.toEqual({ status: "session_missing" });
    expect(syncSession).not.toHaveBeenCalled();
  });

  it("keeps the parked request unconsumed when issuer session sync fails", async () => {
    withIssuer("https://api-staging.eliza.app");

    await expect(
      prepareOidcResumeTarget(RID, "staging.eliza.app", undefined, {
        readToken: () => "token",
        syncSession: () => Promise.reject(new Error("network unavailable")),
      }),
    ).resolves.toEqual({ status: "session_sync_failed" });
  });
});
