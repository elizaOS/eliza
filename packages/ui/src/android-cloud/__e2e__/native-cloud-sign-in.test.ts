/**
 * Eliza's Android native Cloud sign-in host, renderer half: the deployment it
 * signs in to, the one-at-a-time request broker, session activation from the
 * protected slot and the restart listener. Only a mocked port is used; nothing
 * reaches Android, Eliza Cloud or Google.
 */
import { NativeCloudSignInError } from "@elizaos/auth/auth/native-cloud-sign-in";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  getStorageValue: vi.fn<(key: string) => Promise<string | null>>(),
}));
vi.mock("../../bridge/storage-bridge", () => storage);

const session = vi.hoisted(() => ({
  dispatchStewardSessionChange: vi.fn(),
}));
vi.mock("@elizaos/plugin-elizacloud/steward-session-client", () => ({
  STEWARD_TOKEN_KEY: "steward_session_token",
  dispatchStewardSessionChange: session.dispatchStewardSessionChange,
}));

import {
  abandonAndroidNativeCloudSignIn,
  activateAndroidNativeCloudSession,
  activateAndroidNativeCloudSignIn,
  androidNativeCloudApiBase,
  androidNativeCloudEnvironment,
  androidNativeCloudLoginErrorMessage,
  androidNativeCloudSignInMessage,
  clearAndroidNativeCloudCredentialState,
  completeAndroidNativeCloudSignIn,
  type ElizaNativeCloudSignInPort,
  getAndroidNativeCloudSignInRequest,
  listenForAndroidNativeCloudSignInCompleted,
  requestAndroidNativeCloudSignIn,
  resetAndroidNativeCloudSignInForTesting,
  subscribeAndroidNativeCloudSignInRequest,
  subscribeAndroidNativeCloudSignInReturn,
} from "../native-cloud-sign-in";

const authenticated = (environment = "production", extra = {}) => ({
  status: "authenticated",
  environment,
  expiresAt: Date.now() + 60_000,
  accountCreated: false,
  ...extra,
});

beforeEach(() => {
  resetAndroidNativeCloudSignInForTesting();
  storage.getStorageValue.mockReset();
  session.dispatchStewardSessionChange.mockReset();
});
afterEach(() => resetAndroidNativeCloudSignInForTesting());

describe("deployment", () => {
  it("maps every Eliza Cloud alias to its deployment and canonical API", () => {
    expect(androidNativeCloudEnvironment("https://cloud.eliza.app")).toBe(
      "production",
    );
    expect(androidNativeCloudEnvironment("https://eliza.app")).toBe(
      "production",
    );
    expect(androidNativeCloudEnvironment(undefined)).toBe("production");
    expect(
      androidNativeCloudEnvironment("https://cloud-staging.eliza.app/"),
    ).toBe("staging");
    expect(androidNativeCloudEnvironment("https://api-staging.eliza.app")).toBe(
      "staging",
    );
    // An unknown host never selects staging.
    expect(androidNativeCloudEnvironment("https://example.test")).toBe(
      "production",
    );
    expect(androidNativeCloudApiBase("production")).toBe(
      "https://api.eliza.app",
    );
    expect(androidNativeCloudApiBase("staging")).toBe(
      "https://api-staging.eliza.app",
    );
  });

  it("names Eliza and Eliza Cloud in owner-facing copy, never server text", () => {
    expect(
      androidNativeCloudSignInMessage(
        Object.assign(new Error("raw server detail"), { code: "offline" }),
      ),
    ).toBe(
      "Eliza could not reach Eliza Cloud. Check your connection and try again.",
    );
    expect(androidNativeCloudSignInMessage({ code: "not-a-code" })).toBe(
      "Eliza Cloud sign-in is unavailable right now. Try again.",
    );
    expect(
      androidNativeCloudLoginErrorMessage(
        new NativeCloudSignInError("cancelled"),
      ),
    ).toBe("Sign-in cancelled.");
    expect(
      androidNativeCloudLoginErrorMessage(new Error("Could not verify")),
    ).toBe("Could not verify");
  });
});

describe("request broker", () => {
  it("publishes one request and resolves it with a parsed sign-in for that deployment", async () => {
    const seen: Array<number | null> = [];
    const stop = subscribeAndroidNativeCloudSignInRequest(() =>
      seen.push(getAndroidNativeCloudSignInRequest()?.id ?? null),
    );
    const signedIn = requestAndroidNativeCloudSignIn("production");
    const request = getAndroidNativeCloudSignInRequest();
    expect(request).toEqual({ id: 1, environment: "production" });
    // A second caller for the same deployment joins it.
    expect(requestAndroidNativeCloudSignIn("production")).toBe(signedIn);
    // Another deployment is refused while one is open.
    await expect(
      requestAndroidNativeCloudSignIn("staging"),
    ).rejects.toMatchObject({ code: "login-active" });

    completeAndroidNativeCloudSignIn(99, authenticated());
    expect(getAndroidNativeCloudSignInRequest()).not.toBeNull();
    completeAndroidNativeCloudSignIn(1, authenticated());
    await expect(signedIn).resolves.toMatchObject({
      status: "authenticated",
      environment: "production",
      accountCreated: false,
    });
    expect(getAndroidNativeCloudSignInRequest()).toBeNull();
    expect(seen).toEqual([1, null]);
    stop();
  });

  it("refuses an answer for another deployment or with undocumented keys", async () => {
    const wrongDeployment = requestAndroidNativeCloudSignIn("production");
    completeAndroidNativeCloudSignIn(1, authenticated("staging"));
    await expect(wrongDeployment).rejects.toMatchObject({
      code: "unavailable",
    });

    const extraKey = requestAndroidNativeCloudSignIn("production");
    completeAndroidNativeCloudSignIn(2, authenticated("production", { token: "x" }));
    await expect(extraKey).rejects.toMatchObject({ code: "unavailable" });
  });

  it("retains a request after failed account activation and resolves only its successful retry", async () => {
    const activate = vi.fn().mockRejectedValueOnce(new Error("account offline")).mockResolvedValueOnce(undefined);
    const result = requestAndroidNativeCloudSignIn("production", activate);
    const signal = new AbortController().signal;
    await expect(activateAndroidNativeCloudSignIn(1, authenticated(), signal)).rejects.toThrow("account offline");
    expect(getAndroidNativeCloudSignInRequest()?.id).toBe(1);
    await activateAndroidNativeCloudSignIn(1, authenticated(), signal);
    await expect(result).resolves.toMatchObject({ status: "authenticated" });
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it("passes the committed identity through the broker before activating the account", async () => {
    storage.getStorageValue.mockResolvedValue("protected-native-token");
    const outcome = authenticated("production", {
      attemptId: "00000000-0000-4000-8000-000000000001",
      credentialId: "00000000-0000-4000-8000-000000000002",
      requestId: "00000000-0000-4000-8000-000000000003",
    });
    const port = {
      credentialIdentity: vi.fn(async () => ({
        environment: "production",
        credentialId: "00000000-0000-4000-8000-000000000004",
      })),
    } as unknown as ElizaNativeCloudSignInPort;
    const completed = requestAndroidNativeCloudSignIn("production", (signal, committed) =>
      activateAndroidNativeCloudSession(signal, committed, port),
    );
    void completed.catch(() => {});
    await expect(activateAndroidNativeCloudSignIn(1, outcome, new AbortController().signal))
      .rejects.toMatchObject({ code: "state-mismatch" });
    expect(port.credentialIdentity).toHaveBeenCalledOnce();
    expect(session.dispatchStewardSessionChange).not.toHaveBeenCalled();
    expect(getAndroidNativeCloudSignInRequest()?.id).toBe(1);
    abandonAndroidNativeCloudSignIn(1, new NativeCloudSignInError("cancelled"));
    await expect(completed).rejects.toMatchObject({ code: "cancelled" });
  });

  it("abandons with the native failure code and frees the slot", async () => {
    const left = requestAndroidNativeCloudSignIn("staging");
    abandonAndroidNativeCloudSignIn(1, new NativeCloudSignInError("cancelled"));
    await expect(left).rejects.toBeInstanceOf(NativeCloudSignInError);
    await expect(left).rejects.toMatchObject({ code: "cancelled" });
    expect(getAndroidNativeCloudSignInRequest()).toBeNull();
    const next = requestAndroidNativeCloudSignIn("production");
    expect(getAndroidNativeCloudSignInRequest()?.id).toBe(2);
    abandonAndroidNativeCloudSignIn(2, { code: "unknown-code" });
    await expect(next).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("session activation", () => {
  const credentialId = "00000000-0000-4000-8000-000000000001";
  const correlated = {
    status: "authenticated" as const,
    environment: "production" as const,
    credentialId,
    attemptId: "00000000-0000-4000-8000-000000000002",
    accountCreated: false,
    expiresAt: Date.now() + 60_000,
  };
  const identityPort = (read: () => Promise<unknown>) => ({
    credentialIdentity: vi.fn(read),
  }) as unknown as ElizaNativeCloudSignInPort;

  it("confirms the exact installed credential before announcing a correlated completion", async () => {
    storage.getStorageValue.mockResolvedValue("eliza_mobile_saved");
    const port = identityPort(async () => ({ environment: "production", credentialId }));
    await activateAndroidNativeCloudSession(undefined, correlated, port);
    expect(port.credentialIdentity).toHaveBeenCalledWith({ environment: "production" });
    expect(session.dispatchStewardSessionChange).toHaveBeenCalledOnce();
  });

  it.each([
    { environment: "production", credentialId: "00000000-0000-4000-8000-000000000003" },
    { environment: "staging", credentialId },
    { environment: "production", credentialId: null },
    { environment: "production", credentialId, token: "unexpected" },
  ])("does not announce a stale or untrusted installed identity", async value => {
    storage.getStorageValue.mockResolvedValue("eliza_mobile_successor");
    await expect(activateAndroidNativeCloudSession(undefined, correlated, identityPort(async () => value)))
      .rejects.toMatchObject({ code: "state-mismatch" });
    expect(session.dispatchStewardSessionChange).not.toHaveBeenCalled();
  });

  it("does not announce after cancellation while identity readback is pending", async () => {
    storage.getStorageValue.mockResolvedValue("eliza_mobile_saved");
    const owner = new AbortController();
    await expect(activateAndroidNativeCloudSession(owner.signal, correlated, identityPort(async () => {
      owner.abort();
      return { environment: "production", credentialId };
    }))).rejects.toMatchObject({ name: "AbortError" });
    expect(session.dispatchStewardSessionChange).not.toHaveBeenCalled();
  });

  it("re-reads the protected session the native host wrote and announces it", async () => {
    storage.getStorageValue.mockResolvedValue("eliza_mobile_saved");
    await activateAndroidNativeCloudSession();
    expect(storage.getStorageValue).toHaveBeenCalledWith(
      "steward_session_token",
    );
    expect(session.dispatchStewardSessionChange).toHaveBeenCalledWith(
      "present",
    );
  });

  it("treats a missing or unreadable key as a storage failure", async () => {
    storage.getStorageValue.mockResolvedValue(null);
    await expect(activateAndroidNativeCloudSession()).rejects.toMatchObject({
      code: "storage",
    });
    storage.getStorageValue.mockRejectedValue(new Error("keystore"));
    await expect(activateAndroidNativeCloudSession()).rejects.toMatchObject({
      code: "storage",
    });
    expect(session.dispatchStewardSessionChange).not.toHaveBeenCalled();
  });
});

describe("native announcements", () => {
  function mockPort(): ElizaNativeCloudSignInPort & {
    emit(event: string, value: unknown): void;
    removed: number;
  } {
    const listeners = new Map<string, (value: unknown) => void>();
    const port = {
      removed: 0,
      startGoogle: vi.fn(),
      startEmail: vi.fn(),
      verifyEmail: vi.fn(),
      verifyMfa: vi.fn(),
      cancel: vi.fn(async () => {}),
      clearCredentialState: vi.fn(async () => {
        throw new Error("picker unavailable");
      }),
      addListener: vi.fn(async (event: string, listener: (v: unknown) => void) => {
        listeners.set(event, listener);
        return {
          remove: async () => {
            port.removed += 1;
            listeners.delete(event);
          },
        };
      }),
      emit(event: string, value: unknown) {
        listeners.get(event)?.(value);
      },
    };
    return port as never;
  }

  it("queues a completion for the open request before its view mounts, without also activating the cold owner", async () => {
    const port = mockPort(), cold = vi.fn(), receive = vi.fn();
    const remove = await listenForAndroidNativeCloudSignInCompleted("production", cold, port);
    const result = requestAndroidNativeCloudSignIn("production", undefined, {
      port, copy: { serviceName: "Cloud", productName: "Phone" },
    });
    port.emit("signInCompleted", authenticated());
    expect(cold).not.toHaveBeenCalled();
    const unsubscribe = subscribeAndroidNativeCloudSignInReturn(1, receive);
    expect(receive).toHaveBeenCalledOnce();
    completeAndroidNativeCloudSignIn(1, receive.mock.calls[0][0]);
    await result;
    unsubscribe(); remove();
  });

  it("passes on only a parsed restart completion for this deployment", async () => {
    const port = mockPort();
    const handler = vi.fn();
    const remove = await listenForAndroidNativeCloudSignInCompleted(
      "production",
      handler,
      port,
    );
    port.emit("signInCompleted", authenticated("staging"));
    port.emit("signInCompleted", { status: "authenticated" });
    expect(handler).not.toHaveBeenCalled();
    port.emit("signInCompleted", authenticated());
    expect(handler).toHaveBeenCalledTimes(1);
    remove();
    await vi.waitFor(() => expect(port.removed).toBe(1));
  });

  it("clears the native credential picker state best effort", async () => {
    const port = mockPort();
    await expect(
      clearAndroidNativeCloudCredentialState(port),
    ).resolves.toBeUndefined();
    expect(port.clearCredentialState).toHaveBeenCalledTimes(1);
  });
});
