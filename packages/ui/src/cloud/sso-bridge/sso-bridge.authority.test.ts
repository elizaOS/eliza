/** Exercises SSO session transactions against real Node Web Locks and isolated delayed HTTP; no provider or hosted session is contacted. */
// @vitest-environment jsdom

import { locks } from "node:worker_threads";
import {
  clearStoredStewardToken,
  getStewardTabSessionAuthorityCoordinator,
  readStoredStewardToken,
  resetStewardTabSessionAuthorityCoordinatorForTests,
  STEWARD_TOKEN_KEY,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isSsoLoggedOut,
  markSsoBridgeAttempt,
  mintSsoCode,
  performSsoExchange,
  prepareSsoAccountSwitch,
  shouldAttemptSsoBridge,
  shouldAutoBridgeToSso,
} from "./sso-bridge";

const code = `esso_${"a".repeat(64)}`;
const verifier = "b".repeat(64);
const token = `e30.${btoa(JSON.stringify({ userId: "sso-fixture", exp: 4102444800 }))}.synthetic`;
const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixtureFetch(
  implementation: (
    ...args: Parameters<typeof fetch>
  ) => ReturnType<typeof fetch>,
): typeof fetch {
  return implementation as typeof fetch;
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected non-fixture HTTP request");
    }),
  );
  localStorage.clear();
  sessionStorage.clear();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: locks,
  });
  resetStewardTabSessionAuthorityCoordinatorForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalLocks) Object.defineProperty(navigator, "locks", originalLocks);
  else Reflect.deleteProperty(navigator, "locks");
  localStorage.clear();
  sessionStorage.clear();
  resetStewardTabSessionAuthorityCoordinatorForTests();
});

it("does not dispatch a queued SSO exchange after logout wins", async () => {
  const held = deferred(),
    entered = deferred();
  const blocking = getStewardTabSessionAuthorityCoordinator().runExclusive({
    kind: "session-sync",
    work: async () => {
      entered.resolve();
      await held.promise;
    },
  });
  await entered.promise;
  const logout = clearStoredStewardToken();
  const fetchMock = vi.fn(async () => Response.json({ ok: true, token }));
  const pending = performSsoExchange(
    code,
    verifier,
    "cloud.eliza.app",
    fixtureFetch(fetchMock),
  );
  held.resolve();
  await blocking;
  await logout;
  expect((await pending).ok).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(readStoredStewardToken()).toBeNull();
});

describe("mint authority", () => {
  it("does not mint with a queued session after logout wins", async () => {
    await writeStoredStewardToken(token);
    const held = deferred(),
      entered = deferred();
    const coordinator = getStewardTabSessionAuthorityCoordinator();
    const blocking = coordinator.runExclusive({
      kind: "session-sync",
      work: async () => {
        entered.resolve();
        await held.promise;
      },
    });
    await entered.promise;
    const logout = clearStoredStewardToken();
    const fetchMock = vi.fn(async () => Response.json({ code }));
    const pending = mintSsoCode("eliza.app", verifier, fixtureFetch(fetchMock));
    held.resolve();
    await blocking;
    await logout;
    expect((await pending).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("holds mint transport before a queued logout", async () => {
    await writeStoredStewardToken(token);
    const held = deferred(),
      entered = deferred();
    const pending = mintSsoCode(
      "eliza.app",
      verifier,
      fixtureFetch(async () => {
        entered.resolve();
        await held.promise;
        return Response.json({ code });
      }),
    );
    await entered.promise;
    let loggedOut = false;
    const logout = clearStoredStewardToken().then(() => {
      loggedOut = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const endedBeforeMint = loggedOut;
    held.resolve();
    await pending;
    await logout;
    expect(endedBeforeMint).toBe(false);
  });

  it("rejects an original mint ticket after logout and same-token restoration", async () => {
    await writeStoredStewardToken(token);
    const expected = getStewardTabSessionAuthorityCoordinator().readSnapshot();
    await clearStoredStewardToken();
    await writeStoredStewardToken(token);
    const fetchMock = vi.fn(async () => Response.json({ code }));
    const result = await mintSsoCode(
      "eliza.app",
      verifier,
      fixtureFetch(fetchMock),
      { expected },
    );
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("burns a late issued code after its caller cancels without transferring it", async () => {
    await writeStoredStewardToken(token);
    const controller = new AbortController();
    const held = deferred(),
      entered = deferred();
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/mint")) {
        entered.resolve();
        await held.promise;
        return Response.json({ code });
      }
      return new Response(null, { status: 204 });
    });
    const pending = mintSsoCode(
      "eliza.app",
      verifier,
      fixtureFetch(fetchMock),
      { signal: controller.signal },
    );
    await entered.promise;
    controller.abort();
    held.resolve();
    expect((await pending).ok).toBe(false);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://eliza.app/api/auth/sso-bridge/mint",
      "https://eliza.app/api/auth/sso-bridge/burn",
    ]);
    expect(readStoredStewardToken()).toBe(token);
  });
});

it("holds exchange, cookie sync and token commit before a queued logout", async () => {
  const held = deferred(),
    entered = deferred();
  const pending = performSsoExchange(
    code,
    verifier,
    "cloud.eliza.app",
    fixtureFetch(async (url) => {
      if (String(url).includes("/exchange"))
        return Response.json({ ok: true, token });
      entered.resolve();
      await held.promise;
      return Response.json({ ok: true });
    }),
  );
  await entered.promise;
  let loggedOut = false;
  const logout = clearStoredStewardToken().then(() => {
    loggedOut = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const finishedBeforeSync = loggedOut;
  held.resolve();
  expect((await pending).ok).toBe(true);
  await logout;
  expect(finishedBeforeSync).toBe(false);
  expect(readStoredStewardToken()).toBeNull();
});

it("does not publish success or clear retry suppression after rejected cookie sync", async () => {
  markSsoBridgeAttempt();
  const listener = vi.fn();
  window.addEventListener("steward-token-sync", listener);
  try {
    const result = await performSsoExchange(
      code,
      verifier,
      "cloud.eliza.app",
      fixtureFetch(async (url) =>
        String(url).includes("/exchange")
          ? Response.json({ ok: true, token })
          : Response.json({ error: "fixture failure" }, { status: 503 }),
      ),
    );
    expect(result.ok).toBe(false);
    expect(readStoredStewardToken()).toBeNull();
    expect(shouldAttemptSsoBridge()).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("steward-token-sync", listener);
  }
});

it("does not overwrite a legacy replacement during exchange", async () => {
  const held = deferred(),
    entered = deferred();
  const fetchMock = vi.fn(async () => {
    entered.resolve();
    await held.promise;
    return Response.json({ ok: true, token });
  });
  const pending = performSsoExchange(
    code,
    verifier,
    "cloud.eliza.app",
    fixtureFetch(fetchMock),
  );
  await entered.promise;
  localStorage.setItem(STEWARD_TOKEN_KEY, "replacement-fixture");
  held.resolve();
  expect((await pending).ok).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(readStoredStewardToken()).toBe("replacement-fixture");
});

it("disables automatic bridging and exchange without origin-wide coordination", async () => {
  Reflect.deleteProperty(navigator, "locks");
  expect(shouldAutoBridgeToSso("cloud.eliza.app")).toBe(false);
  const fetchMock = vi.fn(async () => Response.json({ ok: true, token }));
  expect(
    (
      await performSsoExchange(
        code,
        verifier,
        "cloud.eliza.app",
        fixtureFetch(fetchMock),
      )
    ).ok,
  ).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
});

describe("account switch", () => {
  it("keeps the old token until server acknowledgement and queues a later login", async () => {
    await writeStoredStewardToken(token);
    const held = deferred(),
      entered = deferred();
    const switching = prepareSsoAccountSwitch(
      "eliza.app",
      fixtureFetch(async () => {
        entered.resolve();
        await held.promise;
        return Response.json({ ok: true });
      }),
    );
    await entered.promise;
    const replacement = writeStoredStewardToken("next-fixture").then(
      () => null,
      (error: Error) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const beforeSettlement = readStoredStewardToken();
    held.resolve();
    await switching;
    await replacement;
    expect(beforeSettlement).toBe(token);
    expect(isSsoLoggedOut()).toBe(true);
    expect(readStoredStewardToken()).toBeNull();
  });
});
