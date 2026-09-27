// @vitest-environment jsdom

/**
 * iOS native Cloud sign-in (#16420): drives the real mobile PKCE client
 * through a stubbed ASWebAuthenticationSession bridge and a scripted Cloud
 * protocol endpoint. Proves single browser ownership, typed cancellation with
 * verifier cleanup, write-before-ACK credential activation, and that a
 * consumed authorization code is never replayed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  starts: [] as Array<{ url: string; ephemeral?: boolean }>,
  next: null as null | (() => Promise<{ callbackUrl: string }>),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => "ios",
    isNativePlatform: () => true,
    isPluginAvailable: (name: string) => name === "ElizaCloudAuthSession",
  },
  registerPlugin: () => ({
    isAvailable: async () => ({ available: true }),
    start: (options: { url: string; ephemeral?: boolean }) => {
      native.starts.push(options);
      if (!native.next) throw new Error("no scripted session result");
      return native.next();
    },
    cancel: async () => undefined,
  }),
}));

const credential = vi.hoisted(() => ({ token: null as string | null }));

vi.mock("@elizaos/plugin-elizacloud/steward-session-client", () => ({
  readStoredStewardToken: () => credential.token,
  writeStoredStewardToken: async (token: string) => {
    credential.token = token;
  },
  clearStoredStewardToken: async () => {
    credential.token = null;
  },
}));

import { DEFAULT_DIRECT_CLOUD_API_BASE_URL } from "../api/direct-cloud-endpoints";
import {
  IosCloudAuthError,
  isIosNativeCloudAuthAvailable,
  signInWithIosCloud,
} from "./ios-cloud-auth";

const API = DEFAULT_DIRECT_CLOUD_API_BASE_URL;

type Call = { url: string; body: Record<string, unknown> | null };
let calls: Call[];
let tokenStatus: number;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  calls = [];
  tokenStatus = 200;
  credential.token = null;
  native.starts = [];
  native.next = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : null;
      calls.push({ url, body });
      if (url.includes("/api/v1/app-auth/mobile/config")) {
        const params = new URL(url).searchParams;
        return jsonResponse(200, {
          success: true,
          clientId: params.get("clientId"),
          environment: params.get("environment"),
          redirectUri: params.get("redirectUri"),
          codeChallengeMethod: "S256",
        });
      }
      if (url.endsWith("/api/v1/app-auth/mobile/token")) {
        if (tokenStatus !== 200) {
          return jsonResponse(tokenStatus, {
            success: false,
            error: "invalid_grant",
            error_description: "Authorization code was already used.",
          });
        }
        // Inactive until ACK: nothing is stored yet at exchange time.
        expect(credential.token).toBeNull();
        return jsonResponse(200, {
          success: true,
          secret: "mobile-secret",
          credentialId: "cred-1",
        });
      }
      if (url.endsWith("/api/v1/app-auth/mobile/ack")) {
        // The credential must be durably stored before activation.
        expect(credential.token).toBe("mobile-secret");
        return jsonResponse(200, {
          success: true,
          status: "acknowledged",
          credentialId: "cred-1",
        });
      }
      return jsonResponse(404, { success: false });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function lastStart(): { url: string } {
  const start = native.starts.at(-1);
  if (!start) throw new Error("the native session was not started");
  return start;
}

function callbackFor(start: { url: string }, extra = "code=auth-code"): string {
  const returnTo = new URL(start.url).searchParams.get("returnTo") ?? "";
  const state = new URL(returnTo, start.url).searchParams.get("state");
  return `https://eliza.app/auth/callback?${extra}&state=${state}`;
}

describe("iOS native Eliza Cloud sign-in", () => {
  it("reports availability from the native session plugin", async () => {
    await expect(isIosNativeCloudAuthAvailable()).resolves.toBe(true);
  });

  it("exchanges the callback once, stores the credential before ACK, and labels the device", async () => {
    native.next = async () => ({
      callbackUrl: callbackFor(lastStart()),
    });
    const completion = await signInWithIosCloud(API);

    expect(completion.apiBase).toBe(API);
    expect(credential.token).toBe("mobile-secret");
    const start = lastStart();
    const authorize = new URL(
      new URL(start.url).searchParams.get("returnTo") ?? "",
      start.url,
    );
    expect(authorize.searchParams.get("device_name")).toBe("iOS");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(
      calls.filter((call) => call.url.endsWith("/mobile/token")),
    ).toHaveLength(1);
    expect(
      calls.filter((call) => call.url.endsWith("/mobile/ack")),
    ).toHaveLength(1);
  });

  it("joins a concurrent request instead of opening a second browser", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    native.next = async () => {
      await gate;
      return { callbackUrl: callbackFor(lastStart()) };
    };
    const first = signInWithIosCloud(API);
    const second = signInWithIosCloud(API);
    expect(second).toBe(first);
    await vi.waitFor(() => expect(native.starts).toHaveLength(1));
    finish();
    await first;
    expect(native.starts).toHaveLength(1);
  });

  it("maps a user cancel to a typed error and stores nothing", async () => {
    native.next = async () => {
      throw Object.assign(new Error("cancelled"), { code: "cancelled" });
    };
    const error = await signInWithIosCloud(API).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IosCloudAuthError);
    expect((error as IosCloudAuthError).code).toBe("cancelled");
    expect(credential.token).toBeNull();
    expect(calls.some((call) => call.url.endsWith("/mobile/token"))).toBe(
      false,
    );
  });

  it("does not replay a consumed authorization code after a failed exchange", async () => {
    tokenStatus = 400;
    native.next = async () => ({
      callbackUrl: callbackFor(lastStart()),
    });
    await expect(signInWithIosCloud(API)).rejects.toThrow();
    expect(
      calls.filter((call) => call.url.endsWith("/mobile/token")),
    ).toHaveLength(1);
    expect(credential.token).toBeNull();
  });
});
