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
 *      with a mocked `@capacitor/app` (the package is not a declared
 *      dependency of `@elizaos/ui`; the host app supplies it). The "Capacitor
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

import {
  installFirstRunDeepLinkListener,
  routeFirstRunDeepLink,
} from "../deep-link-handler";
import {
  FIRST_RUN_QUERY_NAME,
  FIRST_RUN_QUERY_VALUE,
  FIRST_RUN_TARGET_QUERY_NAME,
} from "../reload-into-first-run-runtime";

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
  addListenerMock.mockImplementation(async (_event, _handler) => ({
    remove: removeMock,
  }));
  getLaunchUrlMock.mockImplementation(async () => null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("routeFirstRunDeepLink", () => {
  it("local deep link routes to the local runtime target", () => {
    const handled = routeFirstRunDeepLink(
      "eliza://first-run/runtime/local",
      URL_SCHEME,
    );

    expect(handled).toBe(true);
    expect(currentParams().get(FIRST_RUN_TARGET_QUERY_NAME)).toBe("local");
  });

  it("cloud deep link routes to the cloud runtime target", () => {
    const handled = routeFirstRunDeepLink(
      "eliza://first-run/runtime/cloud",
      URL_SCHEME,
    );

    expect(handled).toBe(true);
    expect(currentParams().get(FIRST_RUN_TARGET_QUERY_NAME)).toBe("cloud");
  });

  it("remote deep link routes to the remote runtime target", () => {
    const handled = routeFirstRunDeepLink(
      "eliza://first-run/runtime/remote",
      URL_SCHEME,
    );

    expect(handled).toBe(true);
    expect(currentParams().get(FIRST_RUN_TARGET_QUERY_NAME)).toBe("remote");
  });

  it("unknown step opens the default first-run flow without a pinned target", () => {
    const handled = routeFirstRunDeepLink(
      "eliza://first-run/runtime/garbage",
      URL_SCHEME,
    );

    expect(handled).toBe(true);
    const params = currentParams();
    // The first-run flag is set so FirstRunShell stops auto-completing to local on
    // ElizaOS, but no target is pinned so the user lands on first-run setup.
    expect(params.get(FIRST_RUN_QUERY_NAME)).toBe(FIRST_RUN_QUERY_VALUE);
    expect(params.get(FIRST_RUN_TARGET_QUERY_NAME)).toBeNull();
  });

  it("missing step segment opens the default first-run flow (no crash)", () => {
    const handled = routeFirstRunDeepLink(
      "eliza://first-run/runtime",
      URL_SCHEME,
    );

    expect(handled).toBe(true);
    expect(currentParams().get(FIRST_RUN_QUERY_NAME)).toBe(
      FIRST_RUN_QUERY_VALUE,
    );
    expect(currentParams().get(FIRST_RUN_TARGET_QUERY_NAME)).toBeNull();
  });

  it("malformed URL is ignored gracefully (no crash, no mutation)", () => {
    const before = window.location.href;
    const handled = routeFirstRunDeepLink("not-a-url", URL_SCHEME);

    expect(handled).toBe(false);
    expect(window.location.href).toBe(before);
    expect(currentParams().get(FIRST_RUN_QUERY_NAME)).toBeNull();
  });

  it("wrong scheme is ignored (no mutation)", () => {
    const before = window.location.href;
    const handled = routeFirstRunDeepLink(
      "https://example.com/first-run/runtime/local",
      URL_SCHEME,
    );

    expect(handled).toBe(false);
    expect(window.location.href).toBe(before);
    expect(currentParams().get(FIRST_RUN_QUERY_NAME)).toBeNull();
  });

  it("right scheme but non-first-run host is ignored (no mutation)", () => {
    // `eliza://chat` is a real, handled deep link in `apps/app/src/main.tsx`.
    // The first-run router must not swallow it.
    const handled = routeFirstRunDeepLink("eliza://chat", URL_SCHEME);

    expect(handled).toBe(false);
    expect(currentParams().get(FIRST_RUN_QUERY_NAME)).toBeNull();
  });

  it("right scheme + first-run host but wrong inner segment is ignored", () => {
    const handled = routeFirstRunDeepLink(
      "eliza://first-run/something-else",
      URL_SCHEME,
    );

    expect(handled).toBe(false);
    expect(currentParams().get(FIRST_RUN_QUERY_NAME)).toBeNull();
  });

  it("preserves existing search params unrelated to the first-run contract", () => {
    window.history.replaceState(null, "", "http://localhost/?session=abc");

    routeFirstRunDeepLink("eliza://first-run/runtime/cloud", URL_SCHEME);

    const params = currentParams();
    expect(params.get("session")).toBe("abc");
    expect(params.get(FIRST_RUN_QUERY_NAME)).toBe(FIRST_RUN_QUERY_VALUE);
    expect(params.get(FIRST_RUN_TARGET_QUERY_NAME)).toBe("cloud");
  });

  it("overwrites a stale runtimeTarget when the deep-link picks a different one", () => {
    window.history.replaceState(
      null,
      "",
      "http://localhost/?runtime=first-run&runtimeTarget=cloud",
    );

    routeFirstRunDeepLink("eliza://first-run/runtime/local", URL_SCHEME);

    expect(currentParams().get(FIRST_RUN_TARGET_QUERY_NAME)).toBe("local");
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

    // Drive the registered handler with a first-run URL — it must mutate
    // the URL params and NOT fall through to the unmatched hook.
    const handler = addListenerMock.mock.calls[0][1];
    handler({ url: "eliza://first-run/runtime/cloud" });

    expect(currentParams().get(FIRST_RUN_TARGET_QUERY_NAME)).toBe("cloud");
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
    expect(currentParams().get(FIRST_RUN_TARGET_QUERY_NAME)).toBe("local");
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
    expect(currentParams().get(FIRST_RUN_TARGET_QUERY_NAME)).toBe("remote");

    await cleanup();
    expect(removeMock).toHaveBeenCalledTimes(1);
  });
});
