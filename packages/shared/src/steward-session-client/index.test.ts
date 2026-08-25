/** Tests the shared Steward browser-session contract with deterministic DOM state. */
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearStoredStewardToken,
  exchangeStewardCode,
  hasStewardAuthedCookie,
  readStoredStewardToken,
  registerStewardTokenPersistence,
  registerStewardTokenRemoval,
  replaceStoredStewardTokenIfCurrent,
  STEWARD_CSRF_HEADER,
  STEWARD_CSRF_HEADER_VALUE,
  STEWARD_REFRESH_TOKEN_KEY,
  STEWARD_SESSION_CHANGE_EVENT,
  STEWARD_TOKEN_KEY,
  type StewardSessionChangeDetail,
  sanitizeTelegramAccountClaimContinuation,
  stewardAuthedCookieName,
  syncStewardSession,
  writeStoredStewardToken,
} from "./index";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Steward session client CSRF marker header", () => {
  it("syncStewardSession sends the marker header with its JSON POST", async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      seen = init;
      return jsonResponse({ ok: true, userId: "u", stewardUserId: "s" });
    }) as typeof fetch;

    await syncStewardSession("token", null, { fetchImpl });

    const headers = new Headers(seen?.headers);
    expect(headers.get(STEWARD_CSRF_HEADER)).toBe(STEWARD_CSRF_HEADER_VALUE);
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("exchangeStewardCode sends the marker header with its JSON POST", async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      seen = init;
      return jsonResponse({ ok: true, userId: "u", stewardUserId: "s" });
    }) as typeof fetch;

    await exchangeStewardCode("one-time-code", {
      fetchImpl,
      codeVerifier: "verifier",
    });

    const headers = new Headers(seen?.headers);
    expect(headers.get(STEWARD_CSRF_HEADER)).toBe(STEWARD_CSRF_HEADER_VALUE);
  });
});

describe("Telegram account-claim credential", () => {
  it("accepts opaque tokens and rejects guessable platform ids", () => {
    expect(
      sanitizeTelegramAccountClaimContinuation(
        "  opaque-telegram-claim-token  ",
      ),
    ).toBe("opaque-telegram-claim-token");
    expect(
      sanitizeTelegramAccountClaimContinuation("platform:telegram:123456789"),
    ).toBeNull();
    expect(sanitizeTelegramAccountClaimContinuation("short")).toBeNull();
    expect(sanitizeTelegramAccountClaimContinuation(null)).toBeNull();
  });
});

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

describe("Steward session storage transitions", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("publishes ordered typed transitions after canonical writes and clears", async () => {
    const transitions: StewardSessionChangeDetail[] = [];
    const listener = (event: Event) => {
      transitions.push(
        (event as CustomEvent<StewardSessionChangeDetail>).detail,
      );
    };
    window.addEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);

    try {
      await writeStoredStewardToken("steward-token");
      expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe("steward-token");
      await clearStoredStewardToken();
      expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
    } finally {
      window.removeEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);
    }

    expect(transitions).toHaveLength(2);
    expect(transitions[0]?.state).toBe("present");
    expect(transitions[1]?.state).toBe("cleared");
    expect(transitions[1]?.sessionEpoch).toBeGreaterThan(
      transitions[0]?.sessionEpoch ?? 0,
    );
  });

  it("does not advance authority when the same token is persisted again", async () => {
    const transitions: StewardSessionChangeDetail[] = [];
    const listener = (event: Event) => {
      transitions.push(
        (event as CustomEvent<StewardSessionChangeDetail>).detail,
      );
    };
    window.addEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);

    try {
      await writeStoredStewardToken("same-token");
      await writeStoredStewardToken("same-token");
    } finally {
      window.removeEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);
    }

    expect(transitions.map(({ state }) => state)).toEqual(["present"]);
  });

  it("rejects a stale refresh replacement after canonical logout", async () => {
    await writeStoredStewardToken("refresh-source-token");
    await clearStoredStewardToken();

    await expect(
      replaceStoredStewardTokenIfCurrent(
        "refresh-source-token",
        "stale-refreshed-token",
      ),
    ).resolves.toBe(false);
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
  });

  it("revalidates a cached token through the registered durable host", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, "cached-token");
    const persist = vi.fn().mockResolvedValue(undefined);
    const unregister = registerStewardTokenPersistence(persist);

    try {
      await writeStoredStewardToken("cached-token");
    } finally {
      unregister();
    }

    expect(persist).toHaveBeenCalledWith("cached-token");
  });

  it("publishes canonical invalidation before stale refresh-key cleanup can fail", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, "steward-token");
    localStorage.setItem(STEWARD_REFRESH_TOKEN_KEY, "legacy-refresh-token");
    const storageFailure = new Error("legacy refresh storage unavailable");
    const originalRemoveItem = Storage.prototype.removeItem;
    const removeItem = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(function (this: Storage, key: string) {
        if (key === STEWARD_REFRESH_TOKEN_KEY) throw storageFailure;
        return Reflect.apply(originalRemoveItem, this, [key]);
      });
    const transitions: StewardSessionChangeDetail[] = [];
    const listener = (event: Event) => {
      transitions.push(
        (event as CustomEvent<StewardSessionChangeDetail>).detail,
      );
    };
    window.addEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);

    try {
      await expect(clearStoredStewardToken()).rejects.toThrow(storageFailure);
    } finally {
      window.removeEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);
      removeItem.mockRestore();
    }

    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(STEWARD_REFRESH_TOKEN_KEY)).toBe(
      "legacy-refresh-token",
    );
    expect(transitions.map(({ state }) => state)).toEqual(["cleared"]);
  });

  it("fails fast without publishing when canonical storage mutations fail", async () => {
    const storageFailure = new Error("canonical storage unavailable");
    const transitions: StewardSessionChangeDetail[] = [];
    const listener = (event: Event) => {
      transitions.push(
        (event as CustomEvent<StewardSessionChangeDetail>).detail,
      );
    };
    window.addEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw storageFailure;
      });

    try {
      await expect(
        writeStoredStewardToken("steward-token"),
      ).rejects.toMatchObject({
        name: "StewardTokenPersistenceError",
        message: storageFailure.message,
        cause: storageFailure,
      });
    } finally {
      setItem.mockRestore();
    }

    const removeItem = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(() => {
        throw storageFailure;
      });
    try {
      await expect(clearStoredStewardToken()).rejects.toMatchObject({
        name: "StewardTokenRemovalError",
        message: storageFailure.message,
        cause: storageFailure,
      });
    } finally {
      removeItem.mockRestore();
      window.removeEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);
    }

    expect(transitions).toEqual([]);
  });

  it("publishes present only after the host confirms durable persistence", async () => {
    let releasePersistence: () => void = () => {};
    const persistence = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const unregister = registerStewardTokenPersistence(() => persistence);
    const transitions: StewardSessionChangeDetail[] = [];
    const listener = (event: Event) => {
      transitions.push(
        (event as CustomEvent<StewardSessionChangeDetail>).detail,
      );
    };
    window.addEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);

    try {
      const write = writeStoredStewardToken("durable-token");
      await Promise.resolve();
      expect(transitions).toEqual([]);
      releasePersistence();
      await write;
      expect(transitions.map(({ state }) => state)).toEqual(["present"]);
    } finally {
      unregister();
      window.removeEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);
    }
  });

  it("does not publish cleared until the host confirms durable removal", async () => {
    localStorage.setItem(STEWARD_TOKEN_KEY, "steward-token");
    let releaseRemoval: () => void = () => {};
    const removal = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    const unregister = registerStewardTokenRemoval(() => removal);
    const transitions: StewardSessionChangeDetail[] = [];
    const listener = (event: Event) => {
      transitions.push(
        (event as CustomEvent<StewardSessionChangeDetail>).detail,
      );
    };
    window.addEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);

    try {
      const clear = clearStoredStewardToken();
      await Promise.resolve();
      expect(transitions).toEqual([]);
      releaseRemoval();
      await clear;
      expect(transitions.map(({ state }) => state)).toEqual(["cleared"]);
    } finally {
      unregister();
      window.removeEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);
    }
  });

  it("does not disguise a failed canonical read as a missing session", () => {
    const storageFailure = new Error("canonical storage unavailable");
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw storageFailure;
      });

    try {
      expect(() => readStoredStewardToken()).toThrow(storageFailure);
    } finally {
      getItem.mockRestore();
    }
  });
});
