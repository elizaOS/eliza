// @vitest-environment jsdom
//
// Transport-bridge regression for the cloud dashboard's `api-client`. The
// load-bearing guarantee: the WEB path stays same-origin-only and STILL throws
// `CROSS_ORIGIN_API_URL` on any cross-origin absolute URL, while native /
// Electrobun resolves to the single allowlisted Eliza Cloud API host and rides
// `CapacitorHttp` — but ONLY that one host (every other cross-origin target
// still throws, even on native).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capacitorState = vi.hoisted(() => ({ isNative: false }));
const capacitorMocks = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => capacitorState.isNative,
  },
  CapacitorHttp: {
    request: capacitorMocks.request,
  },
}));

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { setBootConfig } from "../../config/boot-config";
import { ApiError, api } from "./api-client";

function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (value: object) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.sig`;
}

const STEWARD_TOKEN = makeJwt({
  userId: "u1",
  exp: 4_102_444_800,
});

function setElectrobun(active: boolean): void {
  const w = window as unknown as { __electrobunWindowId?: number };
  if (active) {
    w.__electrobunWindowId = 1;
  } else {
    delete w.__electrobunWindowId;
  }
}

async function expectCrossOriginThrow(
  promise: Promise<unknown>,
): Promise<void> {
  const err = await promise.then(
    () => {
      throw new Error("expected a CROSS_ORIGIN_API_URL throw, got success");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe("CROSS_ORIGIN_API_URL");
}

describe("cloud api-client transport bridge", () => {
  beforeEach(() => {
    setBootConfig({ branding: {}, cloudApiBase: "https://www.elizacloud.ai" });
    capacitorState.isNative = false;
    setElectrobun(false);
    capacitorMocks.request.mockReset();
    window.localStorage.setItem(STEWARD_TOKEN_KEY, STEWARD_TOKEN);
  });

  afterEach(() => {
    setElectrobun(false);
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  // --- WEB: must stay same-origin-only (the load-bearing assertion) ----------

  describe("web runtime", () => {
    it("STILL throws CROSS_ORIGIN_API_URL on a cross-origin Cloud API URL", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      await expectCrossOriginThrow(
        api("https://api.elizacloud.ai/api/v1/apps"),
      );

      // The throw fires before any transport is touched.
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(capacitorMocks.request).not.toHaveBeenCalled();
    });

    it("STILL throws CROSS_ORIGIN_API_URL on any other cross-origin host", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      await expectCrossOriginThrow(api("https://evil.example.com/api/v1/apps"));

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(capacitorMocks.request).not.toHaveBeenCalled();
    });

    it("routes a same-origin relative path through fetch (unchanged web path)", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ apps: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

      const result = await api<{ apps: unknown[] }>("/api/v1/apps");

      expect(result).toEqual({ apps: [] });
      expect(capacitorMocks.request).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [calledUrl, calledInit] = fetchSpy.mock.calls[0];
      // Same-origin: stays a relative path, never absolutized to the cloud host.
      expect(calledUrl).toBe("/api/v1/apps");
      expect((calledInit as RequestInit).credentials).toBe("include");
      expect(
        new Headers((calledInit as RequestInit).headers).get("Authorization"),
      ).toBe(`Bearer ${STEWARD_TOKEN}`);
    });
  });

  // --- NATIVE: resolve to the allowlisted Cloud API host via CapacitorHttp ----

  describe("native (Capacitor) runtime", () => {
    beforeEach(() => {
      capacitorState.isNative = true;
    });

    it("resolves a relative path to the Cloud API base and rides CapacitorHttp with the Bearer", async () => {
      capacitorMocks.request.mockResolvedValue({
        status: 200,
        data: { apps: [{ id: "app-1" }] },
        headers: {},
      });
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const result = await api<{ apps: { id: string }[] }>("/api/v1/apps");

      expect(result).toEqual({ apps: [{ id: "app-1" }] });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(capacitorMocks.request).toHaveBeenCalledTimes(1);
      expect(capacitorMocks.request).toHaveBeenCalledWith(
        expect.objectContaining({
          // www.elizacloud.ai (boot config) normalized to the API host.
          url: "https://api.elizacloud.ai/api/v1/apps",
          method: "GET",
          // WHATWG Headers lowercases keys; HTTP header names are
          // case-insensitive, so the server reads this identically.
          headers: expect.objectContaining({
            authorization: `Bearer ${STEWARD_TOKEN}`,
          }),
        }),
      );
    });

    it("passes an absolute allowlisted Cloud API URL through without throwing", async () => {
      capacitorMocks.request.mockResolvedValue({
        status: 200,
        data: { ok: true },
        headers: {},
      });

      const result = await api<{ ok: boolean }>(
        "https://api.elizacloud.ai/api/v1/apps/app-1",
      );

      expect(result).toEqual({ ok: true });
      expect(capacitorMocks.request).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://api.elizacloud.ai/api/v1/apps/app-1",
        }),
      );
    });

    it("forwards a JSON body to CapacitorHttp as structured data", async () => {
      capacitorMocks.request.mockResolvedValue({
        status: 200,
        data: { id: "app-1" },
        headers: {},
      });

      await api("/api/v1/apps", {
        method: "POST",
        json: { name: "My App" },
      });

      expect(capacitorMocks.request).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://api.elizacloud.ai/api/v1/apps",
          method: "POST",
          data: { name: "My App" },
          headers: expect.objectContaining({
            "content-type": "application/json",
          }),
        }),
      );
    });

    it("STILL throws CROSS_ORIGIN_API_URL for a NON-allowlisted cross-origin host", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      await expectCrossOriginThrow(api("https://evil.example.com/api/v1/apps"));

      // Never opened wide: the disallowed host hits neither transport.
      expect(capacitorMocks.request).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("surfaces a non-2xx Cloud response as an ApiError", async () => {
      capacitorMocks.request.mockResolvedValue({
        status: 403,
        data: { code: "FORBIDDEN", error: "Nope" },
        headers: {},
      });

      const err = await api("/api/v1/apps").then(
        () => {
          throw new Error("expected rejection");
        },
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(403);
      expect((err as ApiError).code).toBe("FORBIDDEN");
    });
  });

  // --- ELECTROBUN: same native-aware gate via the Electrobun detector --------

  describe("electrobun runtime", () => {
    beforeEach(() => {
      setElectrobun(true);
    });

    it("resolves to the Cloud API base and rides CapacitorHttp", async () => {
      capacitorMocks.request.mockResolvedValue({
        status: 200,
        data: { apps: [] },
        headers: {},
      });
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const result = await api<{ apps: unknown[] }>("/api/v1/apps");

      expect(result).toEqual({ apps: [] });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(capacitorMocks.request).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://api.elizacloud.ai/api/v1/apps",
        }),
      );
    });

    it("STILL throws CROSS_ORIGIN_API_URL for a non-allowlisted host", async () => {
      await expectCrossOriginThrow(api("https://evil.example.com/api/v1/apps"));
      expect(capacitorMocks.request).not.toHaveBeenCalled();
    });
  });

  // --- AUTH FALLBACK (#11930): device-code sign-in stores the cloud API key,
  // never the Steward JWT — native must fall back to it, web must not change.

  describe("cloud API key auth fallback (#11930)", () => {
    const CLOUD_API_KEY = "eliza_cloud_owner_api_key";

    function nativeOk(): void {
      capacitorMocks.request.mockResolvedValue({
        status: 200,
        data: { apps: [] },
        headers: {},
      });
    }

    afterEach(() => {
      delete (globalThis as Record<string, unknown>).__ELIZA_CLOUD_AUTH_TOKEN__;
    });

    it("native: authorizes with the cloud API key when NO Steward token exists (the #11930 401 path)", async () => {
      capacitorState.isNative = true;
      window.localStorage.removeItem(STEWARD_TOKEN_KEY);
      setBootConfig({
        branding: {},
        cloudApiBase: "https://www.elizacloud.ai",
        apiToken: CLOUD_API_KEY,
      });
      nativeOk();

      await api("/api/v1/apps");

      expect(capacitorMocks.request).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://api.elizacloud.ai/api/v1/apps",
          headers: expect.objectContaining({
            authorization: `Bearer ${CLOUD_API_KEY}`,
          }),
        }),
      );
    });

    it("native: does not send a local-agent bearer token as Cloud authorization", async () => {
      capacitorState.isNative = true;
      window.localStorage.removeItem(STEWARD_TOKEN_KEY);
      setBootConfig({
        branding: {},
        cloudApiBase: "https://www.elizacloud.ai",
        apiToken: "local-agent-bearer-token",
      });
      nativeOk();

      await api("/api/v1/apps");

      const call = capacitorMocks.request.mock.calls[0]?.[0];
      expect(call?.url).toBe("https://api.elizacloud.ai/api/v1/apps");
      expect(call?.headers.authorization).toBeUndefined();
    });

    it("native: does not send a non-cloud legacy global token as Cloud authorization", async () => {
      capacitorState.isNative = true;
      window.localStorage.removeItem(STEWARD_TOKEN_KEY);
      (globalThis as Record<string, unknown>).__ELIZA_CLOUD_AUTH_TOKEN__ =
        "legacy-local-agent-bearer-token";
      setBootConfig({
        branding: {},
        cloudApiBase: "https://www.elizacloud.ai",
      });
      nativeOk();

      await api("/api/v1/apps");

      const call = capacitorMocks.request.mock.calls[0]?.[0];
      expect(call?.url).toBe("https://api.elizacloud.ai/api/v1/apps");
      expect(call?.headers.authorization).toBeUndefined();
    });

    it("native: a live Steward JWT still WINS over the cloud API key when both exist", async () => {
      capacitorState.isNative = true;
      // beforeEach already seeded STEWARD_TOKEN_KEY.
      setBootConfig({
        branding: {},
        cloudApiBase: "https://www.elizacloud.ai",
        apiToken: CLOUD_API_KEY,
      });
      nativeOk();

      await api("/api/v1/apps");

      expect(capacitorMocks.request).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: `Bearer ${STEWARD_TOKEN}`,
          }),
        }),
      );
    });

    it("native: an expired Steward JWT is cleared and falls back to the cloud API key", async () => {
      capacitorState.isNative = true;
      window.localStorage.setItem(
        STEWARD_TOKEN_KEY,
        makeJwt({ userId: "u1", exp: Math.floor(Date.now() / 1000) - 600 }),
      );
      setBootConfig({
        branding: {},
        cloudApiBase: "https://www.elizacloud.ai",
        apiToken: CLOUD_API_KEY,
      });
      nativeOk();

      await api("/api/v1/apps");

      expect(capacitorMocks.request).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: `Bearer ${CLOUD_API_KEY}`,
          }),
        }),
      );
      expect(window.localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
    });

    it("native: the __ELIZA_CLOUD_AUTH_TOKEN__ global outranks the REST token, matching getCloudAuthToken()", async () => {
      capacitorState.isNative = true;
      window.localStorage.removeItem(STEWARD_TOKEN_KEY);
      (globalThis as Record<string, unknown>).__ELIZA_CLOUD_AUTH_TOKEN__ =
        "eliza_legacy_global_cloud_token";
      setBootConfig({
        branding: {},
        cloudApiBase: "https://www.elizacloud.ai",
        apiToken: CLOUD_API_KEY,
      });
      nativeOk();

      await api("/api/v1/apps");

      expect(capacitorMocks.request).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: "Bearer eliza_legacy_global_cloud_token",
          }),
        }),
      );
    });

    it("web: stays byte-identical — NO Authorization header from the REST token without a Steward JWT", async () => {
      window.localStorage.removeItem(STEWARD_TOKEN_KEY);
      setBootConfig({
        branding: {},
        cloudApiBase: "https://www.elizacloud.ai",
        apiToken: CLOUD_API_KEY,
      });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ apps: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

      await api("/api/v1/apps");

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, calledInit] = fetchSpy.mock.calls[0];
      expect(
        new Headers((calledInit as RequestInit).headers).get("Authorization"),
      ).toBeNull();
    });
  });
});
