/** Verifies a real login persistence and cookie-sync sequence publishes one authority epoch. */
// @vitest-environment jsdom

import {
  clearStoredStewardToken,
  getStewardTabSessionAuthorityCoordinator,
  readStoredStewardToken,
  resetStewardTabSessionAuthorityCoordinatorForTests,
  STEWARD_SESSION_CHANGE_EVENT,
  STEWARD_TOKEN_KEY,
  type StewardSessionChangeDetail,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exchangeStewardCodeViaApi,
  recoverStewardEmailSessionViaCookie,
  recoverStewardSessionViaCookie,
  refreshStewardSessionViaCookie,
  syncStewardSessionCookie,
} from "./steward-session";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetStewardTabSessionAuthorityCoordinatorForTests();
});

it("publishes exactly one present transition across login persistence and cookie sync", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  const transitions: StewardSessionChangeDetail[] = [];
  const listener = (event: Event) => {
    transitions.push((event as CustomEvent<StewardSessionChangeDetail>).detail);
  };
  window.addEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);

  try {
    await writeStoredStewardToken("login-token");
    await syncStewardSessionCookie("login-token");
  } finally {
    window.removeEventListener(STEWARD_SESSION_CHANGE_EVENT, listener);
  }

  expect(transitions.map(({ state }) => state)).toEqual(["present"]);
});

function gate() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function reply(body: object, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe.each([
  {
    name: "nonce exchange",
    run: () => exchangeStewardCodeViaApi("fixture-code"),
  },
  { name: "cookie refresh", run: () => refreshStewardSessionViaCookie() },
  { name: "cookie sync", run: () => syncStewardSessionCookie("new-fixture") },
])("$name", ({ run }) => {
  it("rejects authority queued behind a completed logout without dispatching", async () => {
    const entered = gate();
    const held = gate();
    const blocker = getStewardTabSessionAuthorityCoordinator().runExclusive({
      kind: "session-sync",
      work: async () => {
        entered.release();
        await held.promise;
      },
    });
    await entered.promise;
    const logout = clearStoredStewardToken();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(reply({ ok: true, token: "fixture-token" }));
    const pending = run().then(
      () => null,
      (error: Error) => error,
    );
    held.release();
    await blocker;
    await logout;
    expect(await pending).toMatchObject({
      code: "STEWARD_SESSION_AUTHORITY_SUPERSEDED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("holds cookie mutation until settlement before canonical logout", async () => {
    await writeStoredStewardToken("old-fixture");
    const entered = gate();
    const held = gate();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      entered.release();
      await held.promise;
      return reply({ ok: true, token: "new-fixture" });
    });
    const pending = run();
    await entered.promise;
    const logout = clearStoredStewardToken();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const beforeSettlement = localStorage.getItem(STEWARD_TOKEN_KEY);
    held.release();
    await pending;
    await logout;
    expect(beforeSettlement).toBe("old-fixture");
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
  });
});

it("does not retry or DELETE a newer session established during cookie-recovery backoff", async () => {
  vi.useFakeTimers();
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, options) =>
      options?.method === "DELETE"
        ? reply({ ok: true })
        : reply({ code: "invalid_token", error: "fixture rejection" }, 401),
    );
  const pending = recoverStewardSessionViaCookie().then(
    () => null,
    (error: Error) => error,
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await writeStoredStewardToken("newer-fixture");
  await vi.advanceTimersByTimeAsync(100);
  expect(await pending).toMatchObject({
    code: "STEWARD_SESSION_AUTHORITY_SUPERSEDED",
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe("newer-fixture");
});

describe("email handoff authority", () => {
  const email = "fixture@example.com";
  const token = `e30.${btoa(JSON.stringify({ email, userId: "fixture", exp: 4102444800 }))}.synthetic`;
  it.each(["logout", "replacement"])(
    "stops retries after %s during email backoff",
    async (winner) => {
      vi.useFakeTimers();
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          reply({ error: "No cookie yet", code: "missing_token" }, 401),
        )
        .mockImplementation(async () => reply({ ok: true, token }));
      const pending = recoverStewardEmailSessionViaCookie(email, {
        intervalMs: 100,
        timeoutMs: 500,
      }).catch((error: Error) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      if (winner === "logout") await clearStoredStewardToken();
      else await writeStoredStewardToken("unrelated-account-fixture");
      await vi.advanceTimersByTimeAsync(100);
      expect(await pending).toMatchObject({
        code: "STEWARD_SESSION_AUTHORITY_SUPERSEDED",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("still verifies a same-email callback arriving in another tab during backoff", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        reply({ error: "No cookie yet", code: "missing_token" }, 401),
      )
      .mockImplementation(async () => reply({ ok: true, token }));
    const pending = recoverStewardEmailSessionViaCookie(email, {
      intervalMs: 100,
      timeoutMs: 500,
    });
    await vi.advanceTimersByTimeAsync(0);
    await writeStoredStewardToken(token);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ ok: true, token });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readStoredStewardToken()).toBe(token);
  });
});
