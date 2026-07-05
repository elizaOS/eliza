// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost/"}

/**
 * Coverage for `../deep-link-handler.ts` — the iOS / Android deep-link entry
 * that lands the user on the requested first-run target when the OS
 * dispatches a `eliza://first-run/runtime/<id>` URL.
 *
 * Two surfaces are exercised:
 *
 *   1. `routeFirstRunDeepLink` — the pure URL parser that mutates
 *      `window.location` via `history.replaceState`. Tested directly so the
 *      assertions speak in terms of the produced query string, not React
 *      state.
 *   2. `installFirstRunDeepLinkListener` — the Capacitor wrapper that wires
 *      `App.addListener("appUrlOpen", ...)` and `App.getLaunchUrl()`. Tested
 *      with a mocked optional-peer `@capacitor/app`. The "Capacitor
 *      bridge unavailable" scenario is exercised at the listener layer —
 *      Capacitor's web shim throws `Native Bridge unavailable` on
 *      `addListener` when no native runtime is attached, so that is the
 *      realistic failure mode this suite simulates.
 *
 * Keeps mobile deep links aligned with the first-run runtime target contract.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

type AppUrlOpenEvent = { url: string };
type AppUrlOpenHandler = (event: AppUrlOpenEvent) => void;
type ListenerHandle = { remove: () => Promise<void> };

const { addListenerMock, getLaunchUrlMock, removeMock } = vi.hoisted(() => {
  const removeMock: Mock<() => Promise<void>> = vi.fn(async () => undefined);
  const addListenerMock: Mock<
    (eventName: string, handler: AppUrlOpenHandler) => Promise<ListenerHandle>
  > = vi.fn(async (_event, _handler) => ({ remove: removeMock }));
  const getLaunchUrlMock: Mock<
    () => Promise<{ url?: string } | null | undefined>
  > = vi.fn(async () => null);
  return {
    addListenerMock,
    removeMock,
    getLaunchUrlMock,
  };
});

vi.mock("@capacitor/app", () => ({
  App: {
    addListener: addListenerMock,
    getLaunchUrl: getLaunchUrlMock,
  },
}));

// The deep-link handler now delegates a matched first-run link to the real
// reload path (`reloadIntoFirstRunRuntime`), which clears the persisted
// active-server record and navigates via `window.location.href`. We spy on it
// so the assertions speak in terms of "was the app forced into first-run for
// target X" rather than a query string nobody reads (#13984).
const { reloadIntoFirstRunRuntimeMock } = vi.hoisted(() => ({
  reloadIntoFirstRunRuntimeMock: vi.fn(),
}));

vi.mock("../reload-into-first-run-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../reload-into-first-run-runtime")>();
  return {
    ...actual,
    reloadIntoFirstRunRuntime: reloadIntoFirstRunRuntimeMock,
  };
});

import {
  installFirstRunDeepLinkListener,
  parseFirstRunRemoteConnectDeepLink,
  routeFirstRunDeepLink,
} from "../deep-link-handler";
import { FIRST_RUN_QUERY_NAME } from "../reload-into-first-run-runtime";

const URL_SCHEME = "eliza";

function resetLocation(): void {
  // jsdom's `window.location.href = ...` triggers a navigation that does not
  // synchronously update `search` / `pathname`; using `history.replaceState`
  // keeps the URL editable from inside the test runner.
  window.history.replaceState(null, "", "http://localhost/");
}

function currentParams(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

beforeEach(() => {
  resetLocation();
  addListenerMock.mockClear();
  getLaunchUrlMock.mockClear();
  removeMock.mockClear();
  reloadIntoFirstRunRuntimeMock.mockClear();
  addListenerMock.mockImplementation(async (_event, _handler) => ({
    remove: removeMock,
  }));
  getLaunchUrlMock.mockImplementation(async () => null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("routeFirstRunDeepLink", () => {
  it.each([
    "local",
    "cloud",
    "remote",
  ] as const)("%s deep link forces first-run into that runtime target via the real reload path", (target) => {
    const handled = routeFirstRunDeepLink(
      `eliza://first-run/runtime/${target}`,
      URL_SCHEME,
    );

    expect(handled).toBe(true);
    // The fix: it does REAL work (clears active-server + location.href reload)
    // instead of a replaceState no-op that no live code reads (#13984).
    expect(reloadIntoFirstRunRuntimeMock).toHaveBeenCalledTimes(1);
    expect(reloadIntoFirstRunRuntimeMock).toHaveBeenCalledWith(target);
  });

  it("unknown step forces first-run WITHOUT a pinned target (user picks)", () => {
    const handled = routeFirstRunDeepLink(
      "eliza://first-run/runtime/garbage",
      URL_SCHEME,
    );

    expect(handled).toBe(true);
    // Still forces first-run, but with no target pinned so the user lands on
    // the runtime picker rather than a silently-chosen runtime.
    expect(reloadIntoFirstRunRuntimeMock).toHaveBeenCalledTimes(1);
    expect(reloadIntoFirstRunRuntimeMock).toHaveBeenCalledWith(undefined);
  });

  it("missing step segment forces the default first-run flow (no crash)", () => {
    const handled = routeFirstRunDeepLink(
      "eliza://first-run/runtime",
      URL_SCHEME,
    );

    expect(handled).toBe(true);
    expect(reloadIntoFirstRunRuntimeMock).toHaveBeenCalledTimes(1);
    expect(reloadIntoFirstRunRuntimeMock).toHaveBeenCalledWith(undefined);
  });

  it("malformed URL is ignored gracefully (no crash, no reload, onUnmatched still fires)", () => {
    const handled = routeFirstRunDeepLink("not-a-url", URL_SCHEME);

    expect(handled).toBe(false);
    expect(reloadIntoFirstRunRuntimeMock).not.toHaveBeenCalled();
    expect(currentParams().get(FIRST_RUN_QUERY_NAME)).toBeNull();
  });

  it("wrong scheme is ignored (returns false so host onUnmatched fires)", () => {
    const handled = routeFirstRunDeepLink(
      "https://example.com/first-run/runtime/local",
      URL_SCHEME,
    );

    expect(handled).toBe(false);
    expect(reloadIntoFirstRunRuntimeMock).not.toHaveBeenCalled();
    expect(currentParams().get(FIRST_RUN_QUERY_NAME)).toBeNull();
  });

  it("right scheme but non-first-run host is NOT swallowed (returns false)", () => {
    // `eliza://chat` is a real, handled deep link in `apps/app/src/main.tsx`.
    // The first-run router must not swallow it — it must return false so the
    // host's onUnmatched switch handles it.
    const handled = routeFirstRunDeepLink("eliza://chat", URL_SCHEME);

    expect(handled).toBe(false);
    expect(reloadIntoFirstRunRuntimeMock).not.toHaveBeenCalled();
  });

  it("right scheme + first-run host but wrong inner segment is ignored", () => {
    const handled = routeFirstRunDeepLink(
      "eliza://first-run/something-else",
      URL_SCHEME,
    );

    expect(handled).toBe(false);
    expect(reloadIntoFirstRunRuntimeMock).not.toHaveBeenCalled();
  });

  // #13984 regression: the pre-fix implementation wrote the first-run query
  // params via `history.replaceState` (no reload, no event) and returned true.
  // Nothing live reads those params, so a matched `local`/`cloud`/`remote`
  // link was a silent no-op. Assert the matched link now performs REAL work
  // (delegates to the reload path) rather than only mutating the URL in place.
  it("a matched bare-target link is NOT a replaceState no-op (does real work)", () => {
    const replaceStateSpy = vi.spyOn(window.history, "replaceState");

    const handled = routeFirstRunDeepLink(
      "eliza://first-run/runtime/local",
      URL_SCHEME,
    );

    expect(handled).toBe(true);
    // The fix must drive the real reload path...
    expect(reloadIntoFirstRunRuntimeMock).toHaveBeenCalledWith("local");
    // ...and must NOT fall back to an in-place replaceState param write that no
    // live code path consumes (the exact swallowed-no-op the issue describes).
    expect(replaceStateSpy).not.toHaveBeenCalled();

    replaceStateSpy.mockRestore();
  });
});

describe("installFirstRunDeepLinkListener", () => {
  it("registers an appUrlOpen handler that routes first-run URLs", async () => {
    const onUnmatched = vi.fn();
    const cleanup = await installFirstRunDeepLinkListener({
      urlScheme: URL_SCHEME,
      onUnmatched,
    });

    expect(addListenerMock).toHaveBeenCalledTimes(1);
    expect(addListenerMock).toHaveBeenCalledWith(
      "appUrlOpen",
      expect.any(Function),
    );

    // Drive the registered handler with a first-run URL — it must force
    // first-run for the target and NOT fall through to the unmatched hook.
    const handler = addListenerMock.mock.calls[0][1];
    handler({ url: "eliza://first-run/runtime/cloud" });

    expect(reloadIntoFirstRunRuntimeMock).toHaveBeenCalledWith("cloud");
    expect(onUnmatched).not.toHaveBeenCalled();

    await cleanup();
    expect(removeMock).toHaveBeenCalledTimes(1);
  });

  it("falls through to onUnmatched for non-first-run URLs", async () => {
    const onUnmatched = vi.fn();
    await installFirstRunDeepLinkListener({
      urlScheme: URL_SCHEME,
      onUnmatched,
    });

    const handler = addListenerMock.mock.calls[0][1];
    handler({ url: "eliza://chat" });

    expect(onUnmatched).toHaveBeenCalledWith("eliza://chat");
    expect(currentParams().get(FIRST_RUN_QUERY_NAME)).toBeNull();
  });

  it("routes the cold-launch URL exposed by getLaunchUrl", async () => {
    getLaunchUrlMock.mockResolvedValueOnce({
      url: "eliza://first-run/runtime/local",
    });

    await installFirstRunDeepLinkListener({ urlScheme: URL_SCHEME });

    expect(getLaunchUrlMock).toHaveBeenCalledTimes(1);
    expect(reloadIntoFirstRunRuntimeMock).toHaveBeenCalledWith("local");
  });

  it("is a no-op when the native Capacitor bridge is unavailable", async () => {
    // The realistic failure mode on a stock web build (no native runtime
    // attached) is `App.addListener` rejecting with "Native Bridge
    // unavailable" — Capacitor's web shim emits exactly that message.
    // Drive the listener with that rejection and assert the registration
    // ends in a clean no-op (cleanup callable, no listener registered,
    // error surfaced via `onError`).
    addListenerMock.mockRejectedValueOnce(
      new Error("Native Bridge unavailable"),
    );

    const onError = vi.fn();
    const cleanup = await installFirstRunDeepLinkListener({
      urlScheme: URL_SCHEME,
      onError,
    });

    // `addListener` was attempted once and rejected; no follow-up calls.
    expect(addListenerMock).toHaveBeenCalledTimes(1);
    // The cold-launch read is skipped when listener registration fails —
    // there is no live listener to deliver the launch URL to.
    expect(getLaunchUrlMock).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe(
      "Native Bridge unavailable",
    );

    // Cleanup is safe to call even though registration failed (trivial no-op).
    expect(() => cleanup()).not.toThrow();
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("reports getLaunchUrl failures via onError without losing the registered listener", async () => {
    getLaunchUrlMock.mockRejectedValueOnce(new Error("launch read failed"));

    const onError = vi.fn();
    const cleanup = await installFirstRunDeepLinkListener({
      urlScheme: URL_SCHEME,
      onError,
    });

    expect(addListenerMock).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toBe(
      "launch read failed",
    );

    // The live `appUrlOpen` listener should still work even when the cold
    // launch read failed.
    const handler = addListenerMock.mock.calls[0][1];
    handler({ url: "eliza://first-run/runtime/remote" });
    expect(reloadIntoFirstRunRuntimeMock).toHaveBeenCalledWith("remote");

    await cleanup();
    expect(removeMock).toHaveBeenCalledTimes(1);
  });
});

describe("parseFirstRunRemoteConnectDeepLink", () => {
  it("captures the remote agent URL from the api param", () => {
    expect(
      parseFirstRunRemoteConnectDeepLink(
        "eliza://first-run/runtime/remote?api=http://127.0.0.1:31337",
        URL_SCHEME,
      ),
    ).toEqual({ apiBase: "http://127.0.0.1:31337" });
  });

  it("decodes a percent-encoded URL (how the OS delivers it)", () => {
    expect(
      parseFirstRunRemoteConnectDeepLink(
        "eliza://first-run/runtime/remote?api=https%3A%2F%2Fagent.example.com",
        URL_SCHEME,
      ),
    ).toEqual({ apiBase: "https://agent.example.com" });
  });

  it.each(["apiBase", "url", "host"])("accepts the %s query alias", (key) => {
    expect(
      parseFirstRunRemoteConnectDeepLink(
        `eliza://first-run/runtime/remote?${key}=https://agent.example.com`,
        URL_SCHEME,
      ),
    ).toEqual({ apiBase: "https://agent.example.com" });
  });

  it("returns null for a bare remote link with no URL (falls through to pre-select)", () => {
    expect(
      parseFirstRunRemoteConnectDeepLink(
        "eliza://first-run/runtime/remote",
        URL_SCHEME,
      ),
    ).toBeNull();
  });

  it("returns null for the local/cloud runtime targets", () => {
    expect(
      parseFirstRunRemoteConnectDeepLink(
        "eliza://first-run/runtime/local?api=http://127.0.0.1:31337",
        URL_SCHEME,
      ),
    ).toBeNull();
    expect(
      parseFirstRunRemoteConnectDeepLink(
        "eliza://first-run/runtime/cloud?api=http://127.0.0.1:31337",
        URL_SCHEME,
      ),
    ).toBeNull();
  });

  it("returns null for a foreign scheme or non-first-run host", () => {
    expect(
      parseFirstRunRemoteConnectDeepLink(
        "evil://first-run/runtime/remote?api=http://127.0.0.1:31337",
        URL_SCHEME,
      ),
    ).toBeNull();
    expect(
      parseFirstRunRemoteConnectDeepLink(
        "eliza://connect/runtime/remote?api=http://127.0.0.1:31337",
        URL_SCHEME,
      ),
    ).toBeNull();
  });

  it("returns null for a malformed URL", () => {
    expect(
      parseFirstRunRemoteConnectDeepLink("not a url", URL_SCHEME),
    ).toBeNull();
  });

  it("ignores an empty api param", () => {
    expect(
      parseFirstRunRemoteConnectDeepLink(
        "eliza://first-run/runtime/remote?api=",
        URL_SCHEME,
      ),
    ).toBeNull();
  });

  // #13692 §4: the remote deep link has NO credential channel. It accepts only
  // api|apiBase|url|host, so a `token`/`accessToken` param is dropped and never
  // becomes an unattended credential against a pairing-enabled remote agent.
  // Documented in packages/app/docs/TEST_AUTH.md and asserted end-to-end in
  // packages/app-core/test/live-agent/auth-pairing-remote-connect.real.e2e.test.ts.
  it.each([
    "token",
    "accessToken",
  ])("drops a smuggled %s credential param, surfacing only the address (#13692)", (credentialKey) => {
    const result = parseFirstRunRemoteConnectDeepLink(
      `eliza://first-run/runtime/remote?api=https://agent.example.com&${credentialKey}=smuggled-secret`,
      URL_SCHEME,
    );
    expect(result).toEqual({ apiBase: "https://agent.example.com" });
    expect(
      (result as Record<string, unknown> | null)?.[credentialKey],
    ).toBeUndefined();
  });

  it("returns null for a link carrying ONLY a credential and no address (#13692 §4)", () => {
    expect(
      parseFirstRunRemoteConnectDeepLink(
        "eliza://first-run/runtime/remote?token=smuggled-secret",
        URL_SCHEME,
      ),
    ).toBeNull();
    expect(
      parseFirstRunRemoteConnectDeepLink(
        "eliza://first-run/runtime/remote?accessToken=smuggled-secret",
        URL_SCHEME,
      ),
    ).toBeNull();
  });
});
