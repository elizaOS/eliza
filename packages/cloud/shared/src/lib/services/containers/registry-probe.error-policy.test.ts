/**
 * Error-policy pins for the ghcr registry probe (#13415).
 *
 * The probe feeds the fleet-upgrade reconciler and the post-provision metadata
 * read; both treat null as "digest unknown → skip, retry next tick". Because
 * the risky action (blue/green upgrade) is the thing that gets skipped, the
 * probe fails SAFE to null on transport/5xx errors rather than throwing (a throw
 * would abort an already-provisioned container or kill the reconciler loop).
 * These tests prove that an INTERNAL failure still surfaces observably — it
 * warns — and stays distinguishable from the designed-empty paths (bare image
 * name, 404) which resolve to null WITHOUT a warning. Drives the real exported
 * function with a mocked global fetch; no network.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { logger } from "../../utils/logger";
import { clearRegistryProbeCache, resolveImageDigest } from "./registry-probe";

const DIGEST = `sha256:${"a".repeat(64)}`;
const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

function headResponse(digest: string | null, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: { get: (k: string) => (k === "docker-content-digest" ? digest : null) },
  } as unknown as Response;
}

let warnSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  clearRegistryProbeCache();
  warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  warnSpy.mockRestore();
  clearRegistryProbeCache();
});

describe("resolveImageDigest — designed-empty stays distinct from internal failure", () => {
  it("resolves a healthy ghcr tag to the manifest digest (real success path)", async () => {
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      if (url.includes("/token")) return jsonResponse({ token: "tok" });
      expect(init?.method).toBe("HEAD");
      return headResponse(DIGEST);
    }) as unknown as typeof fetch;

    const out = await resolveImageDigest("ghcr.io/elizaos/eliza:develop");
    expect(out).toBe(DIGEST);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("designed-empty: a bare (non-ghcr) image name is null with NO fetch and NO warn", async () => {
    const fetchMock = mock(async () => jsonResponse({}));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const out = await resolveImageDigest("eliza-agent:prod-good");
    expect(out).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("designed-empty: a 404 manifest (tag absent) is null with NO warn", async () => {
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("/token")) return jsonResponse({ token: "tok" });
      return headResponse(null, false, 404);
    }) as unknown as typeof fetch;

    const out = await resolveImageDigest("ghcr.io/elizaos/eliza:missing");
    expect(out).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("INTERNAL failure: a token transport error fails safe to null but WARNS (observable)", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;

    const out = await resolveImageDigest("ghcr.io/elizaos/eliza:develop");
    expect(out).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("ghcr token network error");
  });

  it("INTERNAL failure: a 500 from the token endpoint is null but WARNS", async () => {
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("/token")) return jsonResponse({}, false, 500);
      return headResponse(DIGEST);
    }) as unknown as typeof fetch;

    const out = await resolveImageDigest("ghcr.io/elizaos/eliza:develop");
    expect(out).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("ghcr token fetch failed");
  });

  it("INTERNAL failure: a manifest transport error (after a good token) is null but WARNS", async () => {
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("/token")) return jsonResponse({ token: "tok" });
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;

    const out = await resolveImageDigest("ghcr.io/elizaos/eliza:develop");
    expect(out).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("ghcr manifest network error");
  });

  it("INTERNAL failure: a non-404 manifest error (503) is null but WARNS", async () => {
    globalThis.fetch = mock(async (url: string) => {
      if (url.includes("/token")) return jsonResponse({ token: "tok" });
      return headResponse(null, false, 503);
    }) as unknown as typeof fetch;

    const out = await resolveImageDigest("ghcr.io/elizaos/eliza:develop");
    expect(out).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("ghcr manifest fetch failed");
  });

  it("designed-success: a digest-pinned ref short-circuits to the digest with NO fetch/warn", async () => {
    const fetchMock = mock(async () => jsonResponse({}));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const out = await resolveImageDigest(`ghcr.io/elizaos/eliza@${DIGEST}`);
    expect(out).toBe(DIGEST);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
