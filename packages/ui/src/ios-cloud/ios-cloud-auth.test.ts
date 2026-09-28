// @vitest-environment jsdom

/**
 * iOS native Cloud sign-in (#16420): drives the real mobile PKCE client
 * through a stubbed ASWebAuthenticationSession bridge, an in-memory Keychain
 * standing in for `@elizaos/capacitor-secure-store`, and a scripted Cloud
 * protocol endpoint. Proves single browser ownership, typed cancellation,
 * inactive-until-ACK Keychain staging, exact recovery of an interrupted
 * activation, exact-key revocation, and that a consumed authorization code is
 * never replayed.
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

const credential = vi.hoisted(() => ({
  token: null as string | null,
  writeUnavailable: false,
}));
const keychain = vi.hoisted(() => new Map<string, string>());
const keychainFailure = vi.hoisted(() => ({ acknowledgedWrite: false }));

vi.mock("@elizaos/plugin-elizacloud/steward-session-client", () => ({
  readStoredStewardToken: () => credential.token,
  writeStoredStewardToken: async (token: string) => {
    if (credential.writeUnavailable)
      throw new Error("Keychain write unavailable");
    credential.token = token;
  },
  clearStoredStewardToken: async () => {
    credential.token = null;
  },
}));

vi.mock("@elizaos/capacitor-secure-store", () => ({
  ElizaSecureStore: {
    get: async ({ key }: { key: string }) =>
      keychain.has(key)
        ? { ok: true, value: keychain.get(key) }
        : { ok: false, error: "not_found" },
    set: async ({ key, value }: { key: string; value: string }) => {
      if (
        keychainFailure.acknowledgedWrite &&
        JSON.parse(value).acknowledged === true
      ) {
        return { ok: false, error: "Keychain write unavailable" };
      }
      keychain.set(key, value);
      return { ok: true };
    },
    remove: async ({ key }: { key: string }) => {
      keychain.delete(key);
      return { ok: true };
    },
  },
}));

import { DEFAULT_DIRECT_CLOUD_API_BASE_URL } from "../api/direct-cloud-endpoints";
import {
  hasIosNativeCloudCredential,
  IosCloudAuthError,
  isIosNativeCloudAuthAvailable,
  recoverIosCloudCredential,
  revokeIosCloudStagedCredential,
  signInWithIosCloud,
  signOutIosCloud,
} from "./ios-cloud-auth";

const API = DEFAULT_DIRECT_CLOUD_API_BASE_URL;
const STAGED_KEY = "session.cloud_mobile_pending";
const SECRET = `eliza_mobile_${"a".repeat(64)}`;
const CREDENTIAL_ID = "11111111-1111-4111-8111-111111111111";

type Call = {
  url: string;
  method: string;
  authorization: string | null;
  body: Record<string, unknown> | null;
};
let calls: Call[];
let tokenStatus: number;
let ackStatus: number;
let revokeStatus: number;
let ackResponseLost: boolean;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stagedRecord(): Record<string, unknown> | null {
  const raw = keychain.get(STAGED_KEY);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

beforeEach(() => {
  calls = [];
  tokenStatus = 200;
  ackStatus = 200;
  ackResponseLost = false;
  keychainFailure.acknowledgedWrite = false;
  revokeStatus = 200;
  credential.token = null;
  credential.writeUnavailable = false;
  keychain.clear();
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
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        method: init?.method ?? "GET",
        authorization: headers.get("Authorization"),
        body,
      });
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
        // Nothing is staged or active at exchange time.
        expect(keychain.has(STAGED_KEY)).toBe(false);
        return jsonResponse(200, {
          success: true,
          secret: SECRET,
          credentialId: CREDENTIAL_ID,
        });
      }
      if (url.endsWith("/api/v1/app-auth/mobile/ack")) {
        // Inactive until ACK: the secret is durably staged in the Keychain but
        // has not become the renderer's session.
        expect(stagedRecord()).toMatchObject({
          acknowledged: false,
          credentialId: CREDENTIAL_ID,
          secret: SECRET,
        });
        expect(credential.token).not.toBe(SECRET);
        if (ackStatus !== 200) {
          return jsonResponse(ackStatus, {
            success: false,
            error: "temporarily_unavailable",
          });
        }
        if (ackResponseLost) throw new Error("ACK response lost after commit");
        return jsonResponse(200, {
          success: true,
          status: "acknowledged",
          credentialId: CREDENTIAL_ID,
        });
      }
      if (
        url.endsWith("/api/v1/api-keys/current") &&
        init?.method === "DELETE"
      ) {
        return revokeStatus === 200
          ? jsonResponse(200, { success: true, credentialId: CREDENTIAL_ID })
          : jsonResponse(revokeStatus, {
              success: false,
              error: "Revocation unavailable",
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

  it("exchanges once, stages until ACK, then activates the Keychain credential", async () => {
    native.next = async () => ({
      callbackUrl: callbackFor(lastStart()),
    });
    const completion = await signInWithIosCloud(API);

    expect(completion.apiBase).toBe(API);
    expect(credential.token).toBe(SECRET);
    expect(keychain.has(STAGED_KEY)).toBe(false);
    expect(hasIosNativeCloudCredential()).toBe(true);
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

  it("retains ambiguous staging after ACK failure until recovery confirms revocation", async () => {
    credential.token = "previous-session";
    ackStatus = 400;
    native.next = async () => ({
      callbackUrl: callbackFor(lastStart()),
    });
    await expect(signInWithIosCloud(API)).rejects.toThrow();
    expect(credential.token).toBe("previous-session");
    expect(stagedRecord()?.secret).toBe(SECRET);
    await expect(recoverIosCloudCredential(API)).resolves.toBe("discarded");
    expect(credential.token).toBe("previous-session");
    expect(keychain.has(STAGED_KEY)).toBe(false);
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
    expect(keychain.has(STAGED_KEY)).toBe(false);
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

describe("iOS Keychain credential recovery", () => {
  it("discards an unacknowledged staged credential instead of activating it", async () => {
    keychain.set(
      STAGED_KEY,
      JSON.stringify({
        version: 1,
        acknowledged: false,
        credentialId: CREDENTIAL_ID,
        secret: SECRET,
      }),
    );
    await expect(recoverIosCloudCredential(API)).resolves.toBe("discarded");
    expect(credential.token).toBeNull();
    expect(keychain.has(STAGED_KEY)).toBe(false);
  });

  it("promotes an acknowledged staged credential exactly once", async () => {
    keychain.set(
      STAGED_KEY,
      JSON.stringify({
        version: 1,
        acknowledged: true,
        credentialId: CREDENTIAL_ID,
        secret: SECRET,
      }),
    );
    await expect(recoverIosCloudCredential(API)).resolves.toBe("activated");
    expect(credential.token).toBe(SECRET);
    expect(keychain.has(STAGED_KEY)).toBe(false);
    await expect(recoverIosCloudCredential(API)).resolves.toBe("none");
  });

  it("resumes an acknowledged credential without opening a second browser", async () => {
    keychain.set(
      STAGED_KEY,
      JSON.stringify({
        version: 1,
        acknowledged: true,
        credentialId: CREDENTIAL_ID,
        secret: SECRET,
      }),
    );
    const completion = await signInWithIosCloud(API);
    expect(completion.state).toBe("recovered");
    expect(credential.token).toBe(SECRET);
    expect(native.starts).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe("iOS Cloud sign-out", () => {
  function stageCredential(acknowledged = true): void {
    keychain.set(
      STAGED_KEY,
      JSON.stringify({
        version: 1,
        acknowledged,
        credentialId: CREDENTIAL_ID,
        secret: SECRET,
      }),
    );
  }

  it.each([null, `eliza_mobile_${"b".repeat(64)}`])(
    "revokes an acknowledged staged credential without promoting it over %s",
    async (previous) => {
      credential.token = previous;
      credential.writeUnavailable = true;
      native.next = async () => ({ callbackUrl: callbackFor(lastStart()) });
      await expect(signInWithIosCloud(API)).rejects.toThrow(
        "the session could not be saved",
      );
      expect(stagedRecord()?.acknowledged).toBe(true);
      expect(credential.token).toBe(previous);
      credential.writeUnavailable = false;

      await signOutIosCloud(API);

      expect(
        calls
          .filter((call) => call.method === "DELETE")
          .map((call) => call.authorization),
      ).toEqual([
        `Bearer ${SECRET}`,
        ...(previous ? [`Bearer ${previous}`] : []),
      ]);
      expect(credential.token).toBeNull();
      expect(keychain.has(STAGED_KEY)).toBe(false);
      await expect(recoverIosCloudCredential(API)).resolves.toBe("none");
    },
  );

  it("preserves both sessions when staged revocation is unavailable and retries", async () => {
    const previous = `eliza_mobile_${"b".repeat(64)}`;
    credential.token = previous;
    stageCredential();
    revokeStatus = 503;

    await expect(signOutIosCloud(API)).rejects.toThrow(
      "Revocation unavailable",
    );
    expect(credential.token).toBe(previous);
    expect(stagedRecord()?.secret).toBe(SECRET);
    expect(calls.map((call) => call.authorization)).toEqual([
      `Bearer ${SECRET}`,
    ]);

    revokeStatus = 200;
    await signOutIosCloud(API);
    expect(credential.token).toBeNull();
    expect(keychain.has(STAGED_KEY)).toBe(false);
    expect(calls.map((call) => call.authorization)).toEqual([
      `Bearer ${SECRET}`,
      `Bearer ${SECRET}`,
      `Bearer ${previous}`,
    ]);
  });

  it("revokes an unacknowledged staged credential without activating it", async () => {
    stageCredential(false);
    await signOutIosCloud(API);
    expect(calls.map((call) => call.authorization)).toEqual([
      `Bearer ${SECRET}`,
    ]);
    expect(credential.token).toBeNull();
    await expect(recoverIosCloudCredential(API)).resolves.toBe("none");
  });

  it.each(["ack-response", "ack-record"])(
    "revokes the issued credential when %s is lost after server activation",
    async (failure) => {
      ackResponseLost = failure === "ack-response";
      keychainFailure.acknowledgedWrite = failure === "ack-record";
      native.next = async () => ({ callbackUrl: callbackFor(lastStart()) });

      await expect(signInWithIosCloud(API)).rejects.toThrow();
      expect(stagedRecord()?.acknowledged).toBe(false);
      expect(credential.token).toBeNull();

      await signOutIosCloud(API);

      expect(
        calls
          .filter((call) => call.method === "DELETE")
          .map((call) => call.authorization),
      ).toEqual([`Bearer ${SECRET}`]);
      expect(keychain.has(STAGED_KEY)).toBe(false);
      await expect(recoverIosCloudCredential(API)).resolves.toBe("none");
    },
  );

  it("revokes staging separately from an active SSO session", async () => {
    credential.token = "existing-sso-session";
    stageCredential();

    await revokeIosCloudStagedCredential(API);

    expect(calls.map((call) => call.authorization)).toEqual([
      `Bearer ${SECRET}`,
    ]);
    expect(credential.token).toBe("existing-sso-session");
    await expect(recoverIosCloudCredential(API)).resolves.toBe("none");
  });

  it("revokes exactly the presented mobile credential, then clears the Keychain", async () => {
    credential.token = SECRET;
    await signOutIosCloud(API);
    const revoke = calls.find((call) =>
      call.url.endsWith("/api/v1/api-keys/current"),
    );
    expect(revoke?.method).toBe("DELETE");
    expect(revoke?.authorization).toBe(`Bearer ${SECRET}`);
    expect(credential.token).toBeNull();
    expect(keychain.has(STAGED_KEY)).toBe(false);
  });

  it("keeps the local credential when the server refuses revocation", async () => {
    credential.token = SECRET;
    revokeStatus = 503;
    await expect(signOutIosCloud(API)).rejects.toThrow(
      "Revocation unavailable",
    );
    expect(credential.token).toBe(SECRET);
  });
});
