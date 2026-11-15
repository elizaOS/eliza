import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  type AndroidDeepLinkReceipt,
  createMobileLifecycle,
  type DeepLinkApplicationResult,
} from "../src/mobile-lifecycle.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const URL = "eliza://ask";
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture(
  version = 2,
  ios = false,
  launch = ios ? URL : undefined,
  manualLaunch = false,
) {
  const native = {
    pending: 0,
    legacy: undefined as
      | undefined
      | ((receipt: AndroidDeepLinkReceipt) => void),
    timers: [] as Array<() => void>,
    peekRequests: [] as Array<Deferred<AndroidDeepLinkReceipt>>,
    acknowledgements: [] as Array<{
      id: number;
      deferred: Deferred<{ cleared: boolean }>;
    }>,
    calls: [] as Array<{
      generation: number;
      id: number;
      deferred: Deferred<DeepLinkApplicationResult> | null;
    }>,
    generation: 0,
    now: 0,
    manualLaunch,
    launchRequests: [] as Array<
      Pick<Deferred<AndroidDeepLinkReceipt>, "resolve" | "reject">
    >,
    throwNext: false,
    currentId: 0,
    startOrder: [] as number[],
    launch,
  };
  const bridge = {
    peekPendingUrl: () => {
      const request = deferred<AndroidDeepLinkReceipt>();
      native.peekRequests.push(request);
      return request.promise;
    },
    acknowledgePendingUrl: (options: { receiptId: string }) => {
      const request = deferred<{ cleared: boolean }>();
      native.acknowledgements.push({
        id: Number(options.receiptId),
        deferred: request,
      });
      return request.promise;
    },
  };
  function create() {
    native.timers = [];
    native.peekRequests = [];
    Date.now = () => native.now;
    Object.assign(globalThis, {
      __mobileFixture: native,
      document: new EventTarget(),
      window: new EventTarget(),
      setInterval: (callback: () => void) => {
        native.timers.push(callback);
        return { unref() {} };
      },
      clearInterval: () => {},
    });
    const lifecycle = createMobileLifecycle({
      isNative: false,
      isIOS: ios,
      isAndroid: !ios,
      logPrefix: "[quint-mobile]",
      handleDeepLink: () => {
        const request = deferred<DeepLinkApplicationResult>();
        native.calls.push({
          generation: native.generation,
          id: native.startOrder.shift() ?? native.currentId,
          deferred: request,
        });
        if (native.throwNext) {
          native.throwNext = false;
          native.calls[native.calls.length - 1].deferred = null;
          throw new Error("Injected synchronous application failure");
        }
        return request.promise;
      },
      androidDeepLinkBuffer: ios ? undefined : bridge,
    });
    lifecycle.initializeDeepLinks();
    return lifecycle;
  }
  let lifecycle = create();
  const stagedPeeks = new Map<number, Deferred<AndroidDeepLinkReceipt>>();
  return {
    native,
    ready() {
      lifecycle.initializeAppLifecycle();
    },
    replace() {
      native.generation += 1;
      stagedPeeks.clear();
      lifecycle = create();
    },
    stagePeek(id: number) {
      if (stagedPeeks.has(id)) return;
      if (native.peekRequests.length === 0) native.timers[0]();
      const request = native.peekRequests.shift();
      assert(request);
      stagedPeeks.set(id, request);
    },
    async deliverPeek(id: number) {
      native.currentId = id;
      const request = stagedPeeks.get(id);
      assert(request, `Missing peek for ${id}`);
      stagedPeeks.delete(id);
      request.resolve(
        version === 2
          ? {
              url: id ? URL : null,
              receiptId: id ? String(id) : null,
              receiptVersion: 2,
            }
          : { url: id ? URL : null },
      );
      await tick();
    },
    async deliverWarm(id: number) {
      native.currentId = id;
      const listener = native.legacy;
      assert(listener);
      listener(
        version === 2 && !ios
          ? { url: URL, receiptId: String(id) }
          : { url: URL },
      );
      await tick();
    },
    async finish(id: number, outcome: string) {
      const call = native.calls.find(
        (item) =>
          item.generation === native.generation &&
          item.id === id &&
          item.deferred !== null,
      );
      assert(call, `Missing application ${id}`);
      const request = call.deferred;
      call.deferred = null;
      assert(request);
      if (outcome === "error") {
        request.reject(new Error("Injected asynchronous application failure"));
        await tick();
        return;
      }
      request.resolve(
        outcome === "applied"
          ? true
          : outcome === "rejected"
            ? { rejected: true }
            : false,
      );
      await tick();
    },
    acknowledge(id: number, outcome: string) {
      const requests = native.acknowledgements.filter((item) => item.id === id);
      assert(requests.length > 0, `Missing acknowledgement ${id}`);
      native.acknowledgements = native.acknowledgements.filter(
        (item) => item.id !== id,
      );
      for (const request of requests) {
        const matches = native.pending === id;
        if (matches) native.pending = 0;
        request.deferred.resolve({
          cleared: outcome === "persisted" && matches,
        });
      }
    },
  };
}

type ModelState = {
  target: number;
  lastAction: string;
  outcome: string;
  queued: number[];
  inFlight: number[];
  attempts: Record<number, number>;
  acknowledgements: number[];
  pendingNative: number;
};
function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if ("#bigint" in record) return Number(record["#bigint"]);
  if ("#set" in record) return (record["#set"] as unknown[]).map(decode);
  if ("#map" in record)
    return Object.fromEntries(
      (record["#map"] as unknown[][]).map(([key, item]) => [
        String(decode(key)),
        decode(item),
      ]),
    );
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, decode(item)]),
  );
}

async function replay(file: string) {
  const trace = JSON.parse(await readFile(file, "utf8")) as {
    states: Array<{ s: unknown }>;
  };
  const states = trace.states.map((row) => decode(row.s) as ModelState);
  assert.equal(states.length, 26);
  const host = fixture();
  await tick();
  const queuedOrder: number[] = [];
  for (const state of states.slice(1)) {
    const id = state.target;
    switch (state.lastAction) {
      case "capture":
        host.native.pending = id;
        break;
      case "dispatchWarm":
        break;
      case "peek":
        host.stagePeek(id);
        break;
      case "deliver":
        if (state.outcome === "warm") await host.deliverWarm(id);
        else await host.deliverPeek(id);
        break;
      case "ready":
        host.native.startOrder = queuedOrder.splice(0);
        host.ready();
        break;
      case "finish":
        await host.finish(id, state.outcome);
        break;
      case "acknowledge":
        host.acknowledge(id, state.outcome);
        break;
      case "replaceRenderer":
        queuedOrder.length = 0;
        host.replace();
        break;
      case "legacyAcknowledge":
        break;
      default:
        throw new Error(`Unknown action ${state.lastAction}`);
    }
    await tick();
    for (const receipt of state.queued) {
      if (!queuedOrder.includes(receipt)) queuedOrder.push(receipt);
    }
    assert.equal(
      host.native.calls.length,
      state.attempts[1] + state.attempts[2],
      file,
    );
    for (const receipt of [1, 2]) {
      assert.equal(
        host.native.calls.filter((call) => call.id === receipt).length,
        state.attempts[receipt],
        file,
      );
    }
    assert.deepEqual(
      [...new Set(host.native.acknowledgements.map((item) => item.id))].sort(),
      state.acknowledgements.sort(),
      file,
    );
    assert.equal(host.native.pending, state.pendingNative, file);
    assert.equal(
      host.native.calls.filter(
        (call) =>
          call.generation === host.native.generation && call.deferred !== null,
      ).length,
      state.inFlight.length,
      file,
    );
  }
  return states.length - 1;
}

type DiscoveryState = {
  version: number;
  lastAction: string;
  lastAttempt: number;
  outcome: string;
  queued: number[];
  inFlight: number[];
  calls: number;
  acknowledgement: boolean;
  nativePending: boolean;
};

async function replayDiscovery(file: string) {
  const trace = JSON.parse(await readFile(file, "utf8")) as {
    states: Array<{ s: unknown }>;
  };
  const states = trace.states.map((row) => decode(row.s) as DiscoveryState);
  assert.equal(states.length, 21);
  const host = fixture(states[0].version, false, URL, true);
  host.native.pending = 1;
  await tick();
  let queuedOrder: number[] = [];
  let previousInFlight: number[] = [];
  for (const state of states.slice(1)) {
    const previousCalls = host.native.calls.length;
    switch (state.lastAction) {
      case "ready":
        host.native.startOrder = queuedOrder.map((id) => 100 + id);
        host.ready();
        break;
      case "launch": {
        const request = host.native.launchRequests.shift();
        assert(request);
        request.resolve({ url: URL });
        break;
      }
      case "peek":
        if (state.outcome === "failed") {
          const request = host.native.peekRequests.shift();
          assert(request);
          request.reject(new Error("Injected version query failure"));
        } else {
          host.stagePeek(1);
          await host.deliverPeek(1);
        }
        break;
      case "app":
        await host.deliverWarm(1);
        break;
      case "expire":
        host.native.now = 15000;
        host.native.timers[0]();
        break;
      case "finish":
        await host.finish(100 + state.lastAttempt, state.outcome);
        break;
      case "acknowledge":
        host.acknowledge(1, "persisted");
        break;
      case "close":
      case "idle":
        break;
      default:
        throw new Error(`Unknown discovery action ${state.lastAction}`);
    }
    await tick();
    const started =
      state.lastAction === "ready"
        ? queuedOrder
        : state.inFlight.filter((name) => !previousInFlight.includes(name));
    assert.equal(
      host.native.calls.length - previousCalls,
      started.length,
      file,
    );
    for (let index = 0; index < started.length; index += 1) {
      host.native.calls[previousCalls + index].id = 100 + started[index];
    }
    queuedOrder = queuedOrder.filter((name) => state.queued.includes(name));
    for (const name of state.queued)
      if (!queuedOrder.includes(name)) queuedOrder.push(name);
    previousInFlight = state.inFlight;
    assert.equal(host.native.calls.length, state.calls, file);
    assert.equal(
      host.native.acknowledgements.length > 0,
      state.acknowledgement,
      file,
    );
    assert.equal(host.native.pending !== 0, state.nativePending, file);
    assert.equal(
      host.native.calls.filter((call) => call.deferred !== null).length,
      state.inFlight.length,
      file,
    );
  }
  return states.length - 1;
}

async function regressions() {
  const host = fixture();
  await tick();
  host.ready();
  await host.deliverWarm(1);
  await host.deliverWarm(2);
  host.native.pending = 2;
  await host.finish(1, "applied");
  assert.deepEqual(
    host.native.acknowledgements.map((item) => item.id),
    [1],
  );
  host.acknowledge(1, "persisted");
  assert.equal(host.native.pending, 2);
  await host.finish(2, "rejected");
  host.acknowledge(2, "persisted");
  assert.equal(host.native.pending, 0);

  const legacy = fixture(1);
  await tick();
  legacy.ready();
  legacy.native.pending = 1;
  legacy.stagePeek(1);
  await legacy.deliverPeek(1);
  await legacy.finish(1, "applied");
  assert.equal(legacy.native.acknowledgements.length, 0);
  assert.equal(legacy.native.pending, 1);
  legacy.native.pending = 2;
  await legacy.deliverWarm(2);
  await legacy.finish(2, "applied");
  assert.equal(legacy.native.calls.length, 2);
  assert.equal(legacy.native.acknowledgements.length, 0);
  assert.equal(legacy.native.pending, 2);
  const concurrentLegacy = fixture(1);
  await tick();
  concurrentLegacy.ready();
  concurrentLegacy.stagePeek(0);
  await concurrentLegacy.deliverPeek(0);
  await concurrentLegacy.deliverWarm(1);
  await concurrentLegacy.deliverWarm(2);
  await concurrentLegacy.finish(1, "error");
  concurrentLegacy.stagePeek(2);
  await concurrentLegacy.deliverPeek(2);
  assert.equal(concurrentLegacy.native.calls.length, 2);
  await concurrentLegacy.finish(2, "applied");
  assert.equal(concurrentLegacy.native.acknowledgements.length, 0);

  const apple = fixture(1, true);
  await tick();
  apple.ready();
  assert.equal(apple.native.calls.length, 1);
  await apple.finish(0, "applied");
  await apple.deliverWarm(1);
  assert.equal(apple.native.calls.length, 1);
  await apple.deliverWarm(1);
  assert.equal(apple.native.calls.length, 2);
  await apple.finish(1, "applied");
  assert.equal(apple.native.acknowledgements.length, 0);

  const cold = fixture();
  await tick();
  cold.ready();
  cold.stagePeek(1);
  await cold.deliverPeek(1);
  await cold.deliverWarm(1);
  assert.equal(cold.native.calls.length, 1);
  assert.equal(cold.native.acknowledgements.length, 0);
  await cold.finish(1, "applied");
  assert(cold.native.acknowledgements.every((item) => item.id === 1));

  const queued = fixture();
  await tick();
  await queued.deliverWarm(1);
  await queued.deliverWarm(2);
  assert.equal(queued.native.calls.length, 0);
  queued.native.startOrder = [1, 2];
  queued.ready();
  assert.equal(queued.native.calls.length, 2);
  await queued.finish(1, "applied");
  assert.deepEqual(
    queued.native.acknowledgements.map((item) => item.id),
    [1],
  );
  await queued.finish(2, "applied");
  assert.deepEqual(
    queued.native.acknowledgements.map((item) => item.id),
    [1, 2],
  );

  const rejectedPeek = fixture(2, false, URL);
  await tick();
  rejectedPeek.ready();
  rejectedPeek.native.peekRequests[0].reject(
    new Error("Injected native query failure"),
  );
  await tick();
  await rejectedPeek.deliverWarm(1);
  assert.equal(rejectedPeek.native.calls.length, 1);
  await rejectedPeek.finish(1, "applied");

  const unavailable = fixture(1, false, URL);
  await tick();
  unavailable.ready();
  assert.equal(unavailable.native.calls.length, 0);
  unavailable.native.now = 15000;
  unavailable.native.timers[0]();
  await tick();
  assert.equal(unavailable.native.calls.length, 1);
  await unavailable.finish(0, "applied");
  assert.equal(unavailable.native.acknowledgements.length, 0);

  const throwing = fixture();
  await tick();
  throwing.ready();
  throwing.native.throwNext = true;
  await throwing.deliverWarm(1);
  assert.equal(throwing.native.acknowledgements.length, 0);
  await throwing.deliverWarm(1);
  await throwing.finish(1, "error");
  assert.equal(throwing.native.acknowledgements.length, 0);
  await throwing.deliverWarm(1);
  await throwing.finish(1, "applied");
  assert.equal(throwing.native.calls.length, 3);
  assert.deepEqual(
    throwing.native.acknowledgements.map((item) => item.id),
    [1],
  );
  console.log("Mobile deep-link receipt regressions passed");
}

await regressions();
const model = process.argv[2];
const traces = process.argv.slice(3);
assert(
  model === "MobileDeepLinkReceipt" || model === "MobileDeepLinkDiscovery",
);
let transitions = 0;
for (const file of traces)
  transitions += await (model === "MobileDeepLinkReceipt"
    ? replay(file)
    : replayDiscovery(file));
console.log(JSON.stringify({ model, traces: traces.length, transitions }));
