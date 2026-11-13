// @vitest-environment jsdom
/** Shared updater state with controlled native replies and actual DOM focus.
 * These checks do not install an APK or qualify Android package authority. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAppUpdateScheduler,
  watchMountedAppUpdates,
} from "../app-update-gate";

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

function scheduleFixture() {
  let now = 0;
  let sequence = 0;
  const jobs = new Map<number, { due: number; callback(): void }>();
  const requests: Array<{
    current(): boolean;
    resolve(): void;
    reject(error: Error): void;
  }> = [];
  const scheduler = createAppUpdateScheduler({
    intervalMs: 4,
    retryMs: 1,
    now: () => now,
    schedule(callback, delay) {
      const id = ++sequence;
      jobs.set(id, { due: now + delay, callback });
      return id;
    },
    cancel(timer) {
      jobs.delete(timer as number);
    },
    run(current) {
      return new Promise<void>((resolve, reject) => {
        requests.push({ current, resolve, reject });
      });
    },
  });
  return {
    scheduler,
    jobs,
    requests,
    advance(value: number) {
      now = value;
    },
    async fire() {
      const entry = [...jobs].find(([, job]) => job.due <= now);
      if (!entry) return false;
      jobs.delete(entry[0]);
      entry[1].callback();
      await flush();
      return true;
    },
  };
}

const activationId = "00000000-0000-0000-0000-000000000001";
const bridgeId = "00000000-0000-0000-0000-000000000002";
const appearance = {
  dialogClass: "update-fixture",
  dialogLabel: "App update",
  pendingLabel: "Updating",
  continueLabel: "Continue",
  navigationEvents: [],
};

async function refusedMountedUpdate(automatic: boolean, initialPending = false) {
  const editor = document.createElement("input");
  editor.value = "An unfinished edit";
  document.body.append(editor);
  editor.focus();
  const pending = {
    pending: true,
    activationId,
    bridgeId,
    phase: "preparing",
    automatic,
  };
  let state: unknown = initialPending ? pending : { pending: false, bridgeId };
  let notify: ((value: unknown) => void) | undefined;
  const acknowledgments: unknown[] = [];
  const preparations: unknown[] = [];
  let refused = 0;
  const port = {
    async updateState() {
      return state;
    },
    async activateUpdate(value: unknown) {
      acknowledgments.push(value);
    },
    async continueUpdate() {},
    async addListener(
      _name: "alphaUpdateReady",
      listener: (value: unknown) => void,
    ) {
      notify = listener;
      return { async remove() {} };
    },
  };
  await watchMountedAppUpdates(
    port,
    appearance,
    async (current, mode, editing) => {
      preparations.push({
        current: current(),
        automatic: mode,
        editing,
        blurred: document.activeElement !== editor,
      });
      throw Error("The editor is still active");
    },
    () => refused++,
  );
  await flush();
  if (!initialPending) {
    state = pending;
    notify?.(pending);
    await flush();
  }
  expect(preparations).toEqual([
    { current: true, automatic, editing: true, blurred: true },
  ]);
  expect(acknowledgments).toEqual([
    { activationId, bridgeId, ready: false },
  ]);
  state = {
    pending: false,
    activationId,
    bridgeId,
    outcome: "failed",
  };
  await vi.advanceTimersByTimeAsync(1000);
  await flush();
  expect(document.querySelector("dialog")).toBeNull();
  expect(editor.value).toBe("An unfinished edit");
  return refused;
}

describe("app update gate", () => {
  let show: PropertyDescriptor | undefined;
  let close: PropertyDescriptor | undefined;
  beforeEach(() => {
    vi.useFakeTimers();
    show = Object.getOwnPropertyDescriptor(
      HTMLDialogElement.prototype,
      "showModal",
    );
    close = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
    // Native modal focus is the platform boundary. The DOM editor and the
    // shipped update gate remain real; the test supplies that one host action.
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value(this: HTMLDialogElement) {
        (document.activeElement as HTMLElement | null)?.blur();
        this.open = true;
      },
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = false;
      },
    });
  });
  afterEach(() => {
    if (show)
      Object.defineProperty(HTMLDialogElement.prototype, "showModal", show);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    if (close) Object.defineProperty(HTMLDialogElement.prototype, "close", close);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it("keeps polling while foreground and backs off failed checks", async () => {
    const f = scheduleFixture();
    f.scheduler.setActive(true);
    expect(await f.fire()).toBe(true);
    f.requests[0].reject(Error("The update server is unavailable"));
    await flush();
    expect(await f.fire()).toBe(false);
    f.advance(1);
    expect(await f.fire()).toBe(true);
    f.requests[1].resolve();
    await flush();
    f.advance(4);
    expect(await f.fire()).toBe(false);
    f.advance(5);
    expect(await f.fire()).toBe(true);
    expect(f.requests).toHaveLength(3);
    f.requests[2].resolve();
    await flush();
    expect(f.scheduler.snapshot().failures).toBe(0);
    f.scheduler.dispose();
    expect(f.jobs.size).toBe(0);
  });

  it("retires a background generation without overlapping its pending operation", async () => {
    const f = scheduleFixture();
    f.scheduler.setActive(true);
    await f.fire();
    expect(f.requests[0].current()).toBe(true);
    f.scheduler.setActive(false);
    f.scheduler.setActive(true);
    expect(f.requests[0].current()).toBe(false);
    expect(await f.fire()).toBe(false);
    expect(f.requests).toHaveLength(1);
    f.requests[0].resolve();
    await flush();
    expect(await f.fire()).toBe(true);
    expect(f.requests[1].current()).toBe(true);
    f.requests[1].resolve();
    await flush();
    f.scheduler.dispose();
    expect(f.jobs.size).toBe(0);
  });

  it("disposes timer ownership while a native call remains pending", async () => {
    const f = scheduleFixture();
    f.scheduler.setActive(true);
    await f.fire();
    f.scheduler.dispose();
    f.scheduler.setActive(true);
    expect(f.requests[0].current()).toBe(false);
    f.requests[0].resolve();
    await flush();
    expect(await f.fire()).toBe(false);
    expect(f.requests).toHaveLength(1);
    expect(f.scheduler.snapshot().busy).toBe(false);
    expect(f.jobs.size).toBe(0);
  });

  it("captures editing before modal focus and refuses automatic preparation quietly", async () => {
    expect(await refusedMountedUpdate(true)).toBe(0);
  });

  it("keeps an explicit refusal visible while preserving native acknowledgment binding", async () => {
    expect(await refusedMountedUpdate(false)).toBe(1);
  });

  it("forwards automatic editing admission on startup readback without a ready event", async () => {
    expect(await refusedMountedUpdate(true, true)).toBe(0);
  });
});
