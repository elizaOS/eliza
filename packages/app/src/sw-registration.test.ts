/**
 * Service-worker update reload wiring through deterministic registration and
 * container fakes. First installation must not replay an auth navigation;
 * replacement workers reload the stale renderer exactly once.
 */

import { describe, expect, it, vi } from "vitest";
import {
  isAuthNavigationUrl,
  wireServiceWorkerUpdateReload,
} from "./sw-registration";

interface ListenerStore {
  registration: Map<string, EventListener>;
  container: Map<string, EventListener>;
}

function makeHarness(
  hasController: boolean,
  currentUrl = "https://staging.eliza.app/chat",
) {
  const listeners: ListenerStore = {
    registration: new Map(),
    container: new Map(),
  };
  const registration = {
    waiting: null,
    installing: null,
    addEventListener(type: string, listener: EventListener) {
      listeners.registration.set(type, listener);
    },
  } as unknown as ServiceWorkerRegistration;
  const serviceWorkers = {
    controller: hasController ? ({} as ServiceWorker) : null,
    addEventListener(type: string, listener: EventListener) {
      listeners.container.set(type, listener);
    },
  } as unknown as ServiceWorkerContainer;
  const reload = vi.fn();

  wireServiceWorkerUpdateReload(
    registration,
    serviceWorkers,
    reload,
    () => currentUrl,
  );

  return { listeners, reload };
}

describe("service-worker controller-change reload", () => {
  it("does not reload when the first worker claims an uncontrolled page", () => {
    const { listeners, reload } = makeHarness(false);

    listeners.container.get("controllerchange")?.(
      new Event("controllerchange"),
    );

    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads exactly once when a replacement worker takes control", () => {
    const { listeners, reload } = makeHarness(true);
    const controllerChange = listeners.container.get("controllerchange");

    controllerChange?.(new Event("controllerchange"));
    controllerChange?.(new Event("controllerchange"));

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it.each([
    "https://staging.eliza.app/auth/bridge?state=state",
    "https://staging.eliza.app/login?code=one-time-code",
    "https://staging.eliza.app/oidc/continue?rid=eoq_request",
  ])("does not replay an auth-sensitive update navigation: %s", (url) => {
    const { listeners, reload } = makeHarness(true, url);

    listeners.container.get("controllerchange")?.(
      new Event("controllerchange"),
    );

    expect(reload).not.toHaveBeenCalled();
  });
});

describe("service-worker auth navigation classification", () => {
  it("matches exact auth route families without blocking ordinary app pages", () => {
    expect(isAuthNavigationUrl("https://eliza.app/login")).toBe(true);
    expect(isAuthNavigationUrl("https://eliza.app/auth/email-callback")).toBe(
      true,
    );
    expect(isAuthNavigationUrl("https://eliza.app/oidc/continue")).toBe(true);
    expect(isAuthNavigationUrl("https://eliza.app/chat")).toBe(false);
    expect(isAuthNavigationUrl("https://eliza.app/login-history")).toBe(false);
  });
});
