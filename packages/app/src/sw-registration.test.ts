/**
 * Service-worker update activation wiring through deterministic registration
 * and container fakes. The page may activate a replacement worker but never
 * becomes a second navigation owner; the real worker owns the one safe refresh.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearDevelopmentServiceWorkers,
  registerViewServiceWorker,
  wireServiceWorkerUpdateActivation,
} from "./sw-registration";

interface ListenerStore {
  registration: Map<string, EventListener>;
  worker: Map<string, EventListener>;
}

function makeHarness({
  hasController,
  waiting = false,
}: {
  hasController: boolean;
  waiting?: boolean;
}) {
  const listeners: ListenerStore = {
    registration: new Map(),
    worker: new Map(),
  };
  const messages: unknown[] = [];
  const worker = {
    state: "installing",
    postMessage(message: unknown) {
      messages.push(message);
    },
    addEventListener(type: string, listener: EventListener) {
      listeners.worker.set(type, listener);
    },
  } as unknown as ServiceWorker;
  const registration = {
    waiting: waiting ? worker : null,
    installing: worker,
    addEventListener(type: string, listener: EventListener) {
      listeners.registration.set(type, listener);
    },
  } as unknown as ServiceWorkerRegistration;
  const serviceWorkers = {
    controller: hasController ? ({} as ServiceWorker) : null,
    addEventListener: vi.fn(),
  } as unknown as ServiceWorkerContainer;

  wireServiceWorkerUpdateActivation(registration, serviceWorkers);

  return { listeners, messages, registration, serviceWorkers, worker };
}

describe("service-worker update activation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not activate an installing worker on its first installation", () => {
    const { listeners, messages, worker } = makeHarness({
      hasController: false,
    });
    listeners.registration.get("updatefound")?.(new Event("updatefound"));
    Object.assign(worker, { state: "installed" });
    listeners.worker.get("statechange")?.(new Event("statechange"));

    expect(messages).toEqual([]);
  });

  it("activates a newly installed replacement worker", () => {
    const { listeners, messages, worker } = makeHarness({
      hasController: true,
    });
    listeners.registration.get("updatefound")?.(new Event("updatefound"));
    Object.assign(worker, { state: "installed" });
    listeners.worker.get("statechange")?.(new Event("statechange"));

    expect(messages).toEqual([{ type: "SKIP_WAITING" }]);
  });

  it("activates a replacement worker that was already waiting", () => {
    const { messages } = makeHarness({ hasController: true, waiting: true });

    expect(messages).toEqual([{ type: "SKIP_WAITING" }]);
  });

  it("never subscribes to controllerchange, leaving navigation to the worker", () => {
    const { serviceWorkers } = makeHarness({ hasController: true });

    expect(serviceWorkers.addEventListener).not.toHaveBeenCalled();
  });

  it("removes stale production workers and reloads a controlled dev document once", async () => {
    const unregisterA = vi.fn(async () => true);
    const unregisterB = vi.fn(async () => false);
    const reload = vi.fn();
    const serviceWorkers = {
      controller: {} as ServiceWorker,
      getRegistrations: vi.fn(async () => [
        { unregister: unregisterA },
        { unregister: unregisterB },
      ]),
    } as unknown as ServiceWorkerContainer;

    await clearDevelopmentServiceWorkers(serviceWorkers, reload);

    expect(unregisterA).toHaveBeenCalledOnce();
    expect(unregisterB).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("does not reload an uncontrolled dev document", async () => {
    const reload = vi.fn();
    const serviceWorkers = {
      controller: null,
      getRegistrations: vi.fn(async () => [
        { unregister: vi.fn(async () => true) },
      ]),
    } as unknown as ServiceWorkerContainer;

    await clearDevelopmentServiceWorkers(serviceWorkers, reload);

    expect(reload).not.toHaveBeenCalled();
  });

  it("registers once when the public shell hands the same document to the full app", async () => {
    vi.stubEnv("PROD", true);
    const registration = {
      waiting: null,
      installing: null,
      scope: "/",
      addEventListener: vi.fn(),
    } as unknown as ServiceWorkerRegistration;
    const register = vi.fn(async () => registration);
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { controller: null, register },
    });

    registerViewServiceWorker();
    registerViewServiceWorker();
    await vi.waitFor(() => expect(register).toHaveBeenCalledOnce());
  });
});
