// Exercises headscale client behavior with deterministic cloud-shared lib fixtures.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeadscaleClient, resolvePreAuthTtlMs } from "./headscale-client";

const originalFetch = globalThis.fetch;

/**
 * The headscale pre-auth key TTL gates the provisioning-E2E reachable path: the
 * key must outlive container boot + VPN enrollment. A 10-min hardcoded window
 * was too tight on slow boots — the key expired mid-registration and the
 * container looped on re-auth (one prod agent hit 176 restarts). The box was
 * bumped to 60 min via HEADSCALE_PREAUTH_TTL_MIN, but the source still hardcoded
 * 10 min, so a daemon redeploy would regress it. This locks the durable repo
 * behavior: 60-min default + the env override that survives a redeploy.
 */
describe("resolvePreAuthTtlMs (headscale pre-auth key TTL)", () => {
  const original = process.env.HEADSCALE_PREAUTH_TTL_MIN;
  afterEach(() => {
    if (original === undefined) delete process.env.HEADSCALE_PREAUTH_TTL_MIN;
    else process.env.HEADSCALE_PREAUTH_TTL_MIN = original;
  });

  it("defaults to 60 minutes (prod-verified; 10 min looped slow boots)", () => {
    delete process.env.HEADSCALE_PREAUTH_TTL_MIN;
    expect(resolvePreAuthTtlMs()).toBe(60 * 60 * 1000);
  });

  it("honors HEADSCALE_PREAUTH_TTL_MIN so the box override survives a redeploy", () => {
    process.env.HEADSCALE_PREAUTH_TTL_MIN = "90";
    expect(resolvePreAuthTtlMs()).toBe(90 * 60 * 1000);
  });

  it("falls back to the 60-min default for non-positive / non-numeric values", () => {
    for (const bad of ["0", "-5", "abc", "", "  "]) {
      process.env.HEADSCALE_PREAUTH_TTL_MIN = bad;
      expect(resolvePreAuthTtlMs()).toBe(60 * 60 * 1000);
    }
  });
});

describe("HeadscaleClient upstream errors", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("preserves unreadable Headscale error bodies as the thrown cause", async () => {
    globalThis.fetch = vi.fn(async () => {
      return {
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        text: async () => {
          throw new Error("body stream failed");
        },
        headers: new Headers(),
      } as Response;
    }) as typeof fetch;

    const client = new HeadscaleClient({
      apiUrl: "https://headscale.example",
      apiKey: "secret",
      user: "1",
    });

    await expect(client.createPreAuthKey()).rejects.toMatchObject({
      message:
        "Headscale API POST /api/v1/preauthkey failed: 502 Bad Gateway; error body could not be read",
      cause: expect.objectContaining({ message: "body stream failed" }),
    });
  });
});
