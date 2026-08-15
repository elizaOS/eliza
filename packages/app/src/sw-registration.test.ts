/**
 * Service-worker update activation wiring through deterministic registration
 * and container fakes. The page may activate a replacement worker but never
 * becomes a second navigation owner; the real worker owns the one safe refresh.
 */

import { describe, expect, it, vi } from "vitest";
import { wireServiceWorkerUpdateActivation } from "./sw-registration";

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
});
