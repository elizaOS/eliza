// @vitest-environment jsdom

/**
 * Coverage for `../deep-link-handler.ts` — the iOS / Android deep-link entry
 * that lands the user on the requested RuntimeGate sub-view when the OS
 * dispatches a `eliza://onboard/step/<id>` URL.
 *
 * Two surfaces are exercised:
 *
 *   1. `routeOnboardingDeepLink` — the pure URL parser that mutates
 *      `window.location` via `history.replaceState`. Tested directly so the
 *      assertions speak in terms of the produced query string, not React
 *      state.
 *   2. `installOnboardingDeepLinkListener` — the Capacitor wrapper that wires
 *      `App.addListener("appUrlOpen", ...)` and `App.getLaunchUrl()`. Tested
 *      with a mocked `@capacitor/app` (the package is not a declared
 *      dependency of `@elizaos/ui`; the host app supplies it). The "Capacitor
 *      bridge unavailable" scenario is exercised at the listener layer —
 *      Capacitor's web shim throws `Native Bridge unavailable` on
 *      `addListener` when no native runtime is attached, so that is the
 *      realistic failure mode this suite simulates.
 *
 * Item 11 in `docs/QA-onboarding-followups.md` (P1) is the upstream tracker
 * for this coverage.
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
  installOnboardingDeepLinkListener,
  routeOnboardingDeepLink,
} from "../deep-link-handler";
import {
  RUNTIME_PICKER_QUERY_NAME,
  RUNTIME_PICKER_QUERY_VALUE,
  RUNTIME_PICKER_TARGET_QUERY_NAME,
} from "../reload-into-runtime-picker";

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

describe("routeOnboardingDeepLink", () => {
  it("provider deep link routes to the local sub-view", () => {
    const handled = routeOnboardingDeepLink(
      "eliza://onboard/step/provider",
      URL_SCHEME,
    );

    expect(handled).toBe(true);
    const params = currentParams();
    expect(params.get(RUNTIME_PICKER_QUERY_NAME)).toBe(
      RUNTIME_PICKER_QUERY_VALUE,
    );
    expect(params.get(RUNTIME_PICKER_TARGET_QUERY_NAME)).toBe("local");
  });

  it("local deep link routes to the local sub-view", () => {
    const handled = routeOnboardingDeepLink(
      "eliza://onboard/step/local",
      URL_SCHEME,
    );

    expect(handled).toBe(true);
    expect(currentParams().get(RUNTIME_PICKER_TARGET_QUERY_NAME)).toBe("local");
  });

  it("cloud deep link routes to the cloud sub-view", () => {
    const handled = routeOnboardingDeepLink(
      "eliza://onboard/step/cloud",
      URL_SCHEME,
    );

    expect(handled).toBe(true);
    expect(currentParams().get(RUNTIME_PICKER_TARGET_QUERY_NAME)).toBe("cloud");
  });

  it("remote deep link routes to the remote sub-view", () => {
    const handled = routeOnboardingDeepLink(
      "eliza://onboard/step/remote",
      URL_SCHEME,
    );

    expect(handled).toBe(true);
    expect(currentParams().get(RUNTIME_PICKER_TARGET_QUERY_NAME)).toBe(
      "remote",
    );
  });

  it("unknown step opens the default chooser without a pinned target", () => {
    const handled = routeOnboardingDeepLink(
      "eliza://onboard/step/garbage",
      URL_SCHEME,
    );

    expect(handled).toBe(true);
    const params = currentParams();
    // The chooser flag is set so RuntimeGate stops auto-completing to local on
    // ElizaOS, but no target is pinned so the user lands on the picker tiles.
    expect(params.get(RUNTIME_PICKER_QUERY_NAME)).toBe(
      RUNTIME_PICKER_QUERY_VALUE,
    );
    expect(params.get(RUNTIME_PICKER_TARGET_QUERY_NAME)).toBeNull();
  });

  it("missing step segment opens the default chooser (no crash)", () => {
    const handled = routeOnboardingDeepLink("eliza://onboard/step", URL_SCHEME);

    expect(handled).toBe(true);
    expect(currentParams().get(RUNTIME_PICKER_QUERY_NAME)).toBe(
      RUNTIME_PICKER_QUERY_VALUE,
    );
    expect(currentParams().get(RUNTIME_PICKER_TARGET_QUERY_NAME)).toBeNull();
  });

  it("malformed URL is ignored gracefully (no crash, no mutation)", () => {
    const before = window.location.href;
    const handled = routeOnboardingDeepLink("not-a-url", URL_SCHEME);

    expect(handled).toBe(false);
    expect(window.location.href).toBe(before);
    expect(currentParams().get(RUNTIME_PICKER_QUERY_NAME)).toBeNull();
  });

  it("wrong scheme is ignored (no mutation)", () => {
    const before = window.location.href;
    const handled = routeOnboardingDeepLink(
      "https://example.com/onboard/step/provider",
      URL_SCHEME,
    );

    expect(handled).toBe(false);
    expect(window.location.href).toBe(before);
    expect(currentParams().get(RUNTIME_PICKER_QUERY_NAME)).toBeNull();
  });

  it("right scheme but non-onboard host is ignored (no mutation)", () => {
    // `eliza://chat` is a real, handled deep link in `apps/app/src/main.tsx`.
    // The onboarding router must NOT swallow it.
    const handled = routeOnboardingDeepLink("eliza://chat", URL_SCHEME);

    expect(handled).toBe(false);
    expect(currentParams().get(RUNTIME_PICKER_QUERY_NAME)).toBeNull();
  });

  it("right scheme + onboard host but wrong inner segment is ignored", () => {
    // `eliza://onboard/something-else` — the path does not start with
    // `/step/`, so the handler bails (caller fall-through can pick it up).
    const handled = routeOnboardingDeepLink(
      "eliza://onboard/something-else",
      URL_SCHEME,
    );

    expect(handled).toBe(false);
    expect(currentParams().get(RUNTIME_PICKER_QUERY_NAME)).toBeNull();
  });

  it("preserves existing search params unrelated to the onboarding contract", () => {
    window.history.replaceState(null, "", "http://localhost/?session=abc");

    routeOnboardingDeepLink("eliza://onboard/step/cloud", URL_SCHEME);

    const params = currentParams();
    expect(params.get("session")).toBe("abc");
    expect(params.get(RUNTIME_PICKER_QUERY_NAME)).toBe(
      RUNTIME_PICKER_QUERY_VALUE,
    );
    expect(params.get(RUNTIME_PICKER_TARGET_QUERY_NAME)).toBe("cloud");
  });

  it("overwrites a stale runtimeTarget when the deep-link picks a different one", () => {
    window.history.replaceState(
      null,
      "",
      "http://localhost/?runtime=picker&runtimeTarget=cloud",
    );

    routeOnboardingDeepLink("eliza://onboard/step/local", URL_SCHEME);

    expect(currentParams().get(RUNTIME_PICKER_TARGET_QUERY_NAME)).toBe("local");
  });
});

describe("installOnboardingDeepLinkListener", () => {
  it("registers an appUrlOpen handler that routes onboarding URLs", async () => {
    const onUnmatched = vi.fn();
    const cleanup = await installOnboardingDeepLinkListener({
      urlScheme: URL_SCHEME,
      onUnmatched,
    });

    expect(addListenerMock).toHaveBeenCalledTimes(1);
    expect(addListenerMock).toHaveBeenCalledWith(
      "appUrlOpen",
      expect.any(Function),
    );

    // Drive the registered handler with an onboarding URL — it must mutate
    // the URL params and NOT fall through to the unmatched hook.
    const handler = addListenerMock.mock.calls[0][1];
    handler({ url: "eliza://onboard/step/cloud" });

    expect(currentParams().get(RUNTIME_PICKER_TARGET_QUERY_NAME)).toBe("cloud");
    expect(onUnmatched).not.toHaveBeenCalled();

    await cleanup();
    expect(removeMock).toHaveBeenCalledTimes(1);
  });

  it("falls through to onUnmatched for non-onboarding URLs", async () => {
    const onUnmatched = vi.fn();
    await installOnboardingDeepLinkListener({
      urlScheme: URL_SCHEME,
      onUnmatched,
    });

    const handler = addListenerMock.mock.calls[0][1];
    handler({ url: "eliza://chat" });

    expect(onUnmatched).toHaveBeenCalledWith("eliza://chat");
    expect(currentParams().get(RUNTIME_PICKER_QUERY_NAME)).toBeNull();
  });

  it("routes the cold-launch URL exposed by getLaunchUrl", async () => {
    getLaunchUrlMock.mockResolvedValueOnce({
      url: "eliza://onboard/step/provider",
    });

    await installOnboardingDeepLinkListener({ urlScheme: URL_SCHEME });

    expect(getLaunchUrlMock).toHaveBeenCalledTimes(1);
    expect(currentParams().get(RUNTIME_PICKER_TARGET_QUERY_NAME)).toBe("local");
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
    const cleanup = await installOnboardingDeepLinkListener({
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
    const cleanup = await installOnboardingDeepLinkListener({
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
    handler({ url: "eliza://onboard/step/remote" });
    expect(currentParams().get(RUNTIME_PICKER_TARGET_QUERY_NAME)).toBe(
      "remote",
    );

    await cleanup();
    expect(removeMock).toHaveBeenCalledTimes(1);
  });
});
