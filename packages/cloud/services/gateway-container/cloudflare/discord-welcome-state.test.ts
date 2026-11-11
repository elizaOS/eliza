import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DISCORD_WELCOME_DELIVERED,
  DISCORD_WELCOME_PENDING,
  DISCORD_WELCOME_PROCESSING,
  DISCORD_WELCOME_REQUEUE,
  DISCORD_WELCOME_REQUEUE_HEADER,
} from "@elizaos/cloud-services-common/discord-welcome-state";
import { Miniflare } from "miniflare";
import { discordWelcomeStore } from "../../gateway-discord/src/cloudflare-welcome-store";
import {
  type DiscordInstallWelcomeJob,
  DiscordInstallWelcomeQueue,
  type DiscordInstallWelcomeRedis,
} from "../../gateway-discord/src/discord-install-welcome-queue";

let worker: Miniflare, script: string, directory: string;
const start = () =>
  new Miniflare({
    compatibilityDate: "2026-04-01",
    compatibilityFlags: ["nodejs_compat"],
    modules: [{ type: "ESModule", path: "worker.mjs", contents: script }],
    durableObjects: {
      DISCORD_WELCOME_STATE: {
        className: "DiscordWelcomeState",
        useSQLite: true,
      },
    },
    durableObjectsPersist: directory,
    outboundService: () => {
      throw new Error("Unexpected external Discord I/O");
    },
  });
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "discord-welcome-"));
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "discord-welcome.fixture.ts")],
    target: "browser",
    external: ["node:*", "cloudflare:*"],
    conditions: ["eliza-source"],
  });
  if (!build.success)
    throw new AggregateError(build.logs, "Welcome fixture failed");
  const output = build.outputs[0];
  if (!output) throw new Error("Missing fixture");
  script = await output.text();
  worker = start();
  await worker.ready;
}, 60_000);
afterAll(async () => {
  await worker?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});
const call = (input: object, path = "/exercise", token = "test-only") =>
  worker.dispatchFetch(`https://welcome.test${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
const ok = async (input: object) => {
  const response = await call(input);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    result: unknown;
    messages: Array<Record<string, unknown>>;
  };
};
const job = (id: string) => ({
  id,
  eventTimestamp: "2026-10-22T00:00:00Z",
  user: { id: `user-${id}`, globalName: id },
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};
const fixtureProvider = (
  send: (body: Record<string, unknown>) => Response | Promise<Response>,
) =>
  Object.assign(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith("/users/@me/channels"))
        return Response.json({ id: "fixture-recovery" });
      if (typeof init?.body !== "string")
        throw new Error("Expected provider JSON");
      return send(JSON.parse(init.body));
    },
    { preconnect: () => {} },
  );
type StoreObserver = (
  input: Record<string, unknown>,
  headers?: Headers,
) => void | Promise<void>;
const welcomeStore = (
  hooks: { before?: StoreObserver; after?: StoreObserver } = {},
) =>
  discordWelcomeStore(
    new Proxy({} as DiscordInstallWelcomeRedis, {
      get: () => () => {
        throw new Error("Unexpected Redis fallback");
      },
    }),
    {
      CLOUD_DISCORD_WELCOME_BACKEND: "cloudflare",
      DISCORD_WELCOME_URL: "https://welcome.test/internal/discord-welcome",
      DISCORD_WELCOME_TOKEN: "test-only",
    },
    async (url, init) => {
      if (typeof init.body !== "string") throw new Error("JSON required");
      const input = JSON.parse(init.body) as Record<string, unknown>;
      await hooks.before?.(input);
      const response = await worker.dispatchFetch(String(url), {
        method: init.method,
        headers: Object.fromEntries(new Headers(init.headers)),
        body: init.body,
      });
      const bytes = await response.arrayBuffer();
      const headers = new Headers(Object.fromEntries(response.headers));
      if (response.ok) await hooks.after?.(input, headers);
      return new Response(bytes, {
        status: response.status,
        headers,
      });
    },
  );
test("quiesced import preserves FIFO order, processing recovery, and delivered markers", async () => {
  const snapshot = {
    operation: "import",
    sourceQuiesced: true,
    pending: [JSON.stringify(job("B")), JSON.stringify(job("A"))],
    processing: [JSON.stringify(job("C"))],
    delivered: [
      {
        key: DISCORD_WELCOME_DELIVERED + "B",
        value: "1",
        expiresAt: Date.now() + 60000,
      },
      {
        key: DISCORD_WELCOME_DELIVERED + "expired",
        value: "1",
        expiresAt: Date.now() - 1000,
      },
    ],
  };
  expect(
    (await call({ ...snapshot, sourceQuiesced: false }, "/private")).status,
  ).toBe(400);
  expect((await call(snapshot, "/private")).status).toBe(200);
  expect((await call(snapshot, "/private")).status).toBe(200);
  expect((await call({ ...snapshot, pending: [] }, "/private")).status).toBe(
    409,
  );
  expect(
    (await ok({ action: "marker", key: DISCORD_WELCOME_DELIVERED + "expired" }))
      .result,
  ).toBeNull();
  const first = await ok({ action: "drain" });
  expect(first.result).toBe(true);
  expect(first.messages).toHaveLength(1);
  expect(first.messages[0]?.content).toContain("Hey A");
  expect(first.messages[0]?.enforce_nonce).toBe(true);
  const skipped = await ok({ action: "drain" });
  expect(skipped.messages).toHaveLength(1);
  const recovered = await ok({ action: "drain" });
  expect(recovered.messages).toHaveLength(2);
  expect(recovered.messages[1]?.content).toContain("Hey C");
  expect((await ok({ action: "drain" })).result).toBe(false);
  await worker.dispose();
  worker = start();
  await worker.ready;
  expect((await call(snapshot, "/private")).status).toBe(409);
  await ok({ action: "enqueue", job: job("A") });
  expect((await ok({ action: "drain" })).messages).toHaveLength(0);
});
test("an abandoned processing claim survives restart with its complete payload", async () => {
  const queued = {
    ...job("crash"),
    user: { id: "user-crash", globalName: "complete é".repeat(5000) },
  };
  await ok({ action: "enqueue", job: queued });
  expect((await ok({ action: "claim" })).result).toBe(JSON.stringify(queued));
  await worker.dispose();
  worker = start();
  await worker.ready;
  const recovered = await ok({ action: "drain" });
  expect(recovered.messages).toHaveLength(1);
  expect(recovered.messages[0]?.content).toContain(queued.user.globalName);
  await worker.dispose();
  worker = start();
  await worker.ready;
  await ok({ action: "enqueue", job: queued });
  expect((await ok({ action: "drain" })).messages).toHaveLength(0);
}, 30_000);
test("public queue transport rejects imports, unauthorized callers and foreign lists", async () => {
  expect(
    (
      await call(
        { operation: "get", key: DISCORD_WELCOME_DELIVERED + "A" },
        "/internal/discord-welcome",
        "wrong",
      )
    ).status,
  ).toBe(401);
  expect(
    (await call({ operation: "import" }, "/internal/discord-welcome")).status,
  ).toBe(400);
  expect(
    (
      await call(
        { operation: "push", key: "another-queue", values: ["payload"] },
        "/internal/discord-welcome",
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await call(
        { operation: ["get"], key: DISCORD_WELCOME_DELIVERED + "A" },
        "/internal/discord-welcome",
      )
    ).status,
  ).toBe(400);
});

test("stop joins processing recovery and leaves the welcome available to the next owner", async () => {
  const queued = job("stop-during-recovery");
  await ok({ action: "enqueue", job: queued });
  expect((await ok({ action: "claim" })).result).toBe(JSON.stringify(queued));
  const entered = deferred();
  const release = deferred();
  let recovering = false;
  const store = welcomeStore({
    after: async (input) => {
      if (
        recovering ||
        input.operation !== "move" ||
        input.source !== DISCORD_WELCOME_PROCESSING
      )
        return;
      recovering = true;
      entered.resolve();
      // The actual SQLite move completed. Only delivery of its reply is held.
      await release.promise;
    },
  });
  let sends = 0;
  const provider = fixtureProvider(() => {
    sends++;
    return Response.json({ id: "fixture-message" });
  });
  const queue = new DiscordInstallWelcomeQueue(
    store,
    "fixture-token",
    provider,
  );
  const starting = queue.start();
  let stopping: Promise<void> | undefined;
  let stopReturnedBeforeRecovery = false;
  try {
    await Promise.race([
      entered.promise,
      starting.then(() => {
        throw new Error("No processing recovery request");
      }),
    ]);
    let stopped = false;
    stopping = queue.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(0);
    stopReturnedBeforeRecovery = stopped;
  } finally {
    release.resolve();
    await Promise.allSettled([starting, stopping]);
    await queue.stop();
  }
  expect({ stopReturnedBeforeRecovery, sends }).toEqual({
    stopReturnedBeforeRecovery: false,
    sends: 0,
  });
  expect((await ok({ action: "claim" })).result).toBe(JSON.stringify(queued));
  const nextOwner = new DiscordInstallWelcomeQueue(
    store,
    "fixture-token",
    provider,
  );
  expect(await nextOwner.drainOnce()).toBe(true);
  expect(sends).toBe(1);
  expect(await store.get<string>(DISCORD_WELCOME_DELIVERED + queued.id)).toBe(
    "1",
  );
  expect(await nextOwner.drainOnce()).toBe(false);
});

test("stop joins admitted delivery before another startup can recover its claim", async () => {
  const queued = job("stop-during-delivery");
  await ok({ action: "enqueue", job: queued });
  const entered = deferred();
  const release = deferred();
  let recoveries = 0;
  const store = welcomeStore({
    after: (input) => {
      if (
        input.operation === "move" &&
        input.source === DISCORD_WELCOME_PROCESSING
      )
        recoveries++;
    },
  });
  let sends = 0;
  const provider = fixtureProvider(async () => {
    sends++;
    entered.resolve();
    await release.promise;
    return Response.json({ id: "fixture-message" });
  });
  const queue = new DiscordInstallWelcomeQueue(
    store,
    "fixture-token",
    provider,
  );
  let stopping: Promise<void> | undefined;
  try {
    await queue.start();
    await entered.promise;
    const originalRecoveries = recoveries;
    let stopped = false;
    stopping = queue.stop().then(() => {
      stopped = true;
    });
    await queue.start();
    expect(recoveries).toBe(originalRecoveries);
    expect(stopped).toBe(false);
    expect(await store.get(DISCORD_WELCOME_DELIVERED + queued.id)).toBeNull();
  } finally {
    release.resolve();
    await stopping;
    await queue.stop();
  }
  expect(sends).toBe(1);
  expect(await store.get<string>(DISCORD_WELCOME_DELIVERED + queued.id)).toBe(
    "1",
  );
  expect(await queue.drainOnce()).toBe(false);
});

test("transient welcome delivery retains its payload and nonce through durable retry", async () => {
  const queued = job("transient-delivery");
  const store = welcomeStore();
  const nonces: unknown[] = [];
  const provider = fixtureProvider((body) => {
    nonces.push(body.nonce);
    expect(body.enforce_nonce).toBe(true);
    if (nonces.length === 1)
      return Response.json({ message: "Fixture rate limit" }, { status: 429 });
    return Response.json({ id: "fixture-retry" });
  });
  const queue = new DiscordInstallWelcomeQueue(
    store,
    "fixture-token",
    provider,
  );
  await queue.enqueue(queued);
  const beforeAttempt = Date.now();
  expect(await queue.drainOnce()).toBe(true);
  expect(await store.get(DISCORD_WELCOME_DELIVERED + queued.id)).toBeNull();
  const raw = (await ok({ action: "claim" })).result;
  if (typeof raw !== "string") throw new Error("Missing durable retry");
  const retry = JSON.parse(raw) as DiscordInstallWelcomeJob;
  expect(retry).toEqual({
    ...queued,
    attempts: 1,
    retryAt: expect.any(String),
  });
  const moveBack = () =>
    store.lmove(
      DISCORD_WELCOME_PROCESSING,
      DISCORD_WELCOME_PENDING,
      "right",
      "left",
    );
  expect(await moveBack()).toBe(raw);
  expect(await moveBack()).toBeNull();
  if (!retry.retryAt) throw new Error("Missing retry time");
  expect(Date.parse(retry.retryAt)).toBeGreaterThan(beforeAttempt);
  expect(nonces).toHaveLength(1);
  await worker.dispose();
  worker = start();
  await worker.ready;
  await Bun.sleep(Math.max(0, Date.parse(retry.retryAt) - Date.now() + 10));
  const recovered = new DiscordInstallWelcomeQueue(
    store,
    "fixture-token",
    provider,
  );
  expect(await recovered.drainOnce()).toBe(true);
  expect(nonces).toHaveLength(2);
  expect(nonces[1]).toBe(nonces[0]);
  expect(await store.get<string>(DISCORD_WELCOME_DELIVERED + queued.id)).toBe(
    "1",
  );
  expect(await recovered.drainOnce()).toBe(false);
}, 15_000);

for (const scenario of [
  {
    name: "accepted welcome survives a rejected marker write at the delivery attempt limit",
    operation: "set",
    before: true,
    attempts: 7,
    marker: null,
    remainingClaim: true,
  },
  {
    name: "lost delivered-marker reply preserves the claim for marker replay",
    operation: "set",
    before: false,
    attempts: 0,
    marker: "1",
    remainingClaim: true,
  },
  {
    name: "lost processing-removal reply does not requeue a delivered welcome",
    operation: "remove",
    before: false,
    attempts: 0,
    marker: "1",
    remainingClaim: false,
  },
]) {
  test(scenario.name, async () => {
    const queued = {
      ...job(`receipt-${scenario.operation}-${scenario.before}`),
      attempts: scenario.attempts,
    };
    const markerKey = `${DISCORD_WELCOME_DELIVERED}${queued.id}`;
    const storageError = new Error("Fixture storage reply unavailable");
    const interrupt: StoreObserver = (input) => {
      if (input.operation === scenario.operation) throw storageError;
    };
    const failingStore = welcomeStore(
      scenario.before ? { before: interrupt } : { after: interrupt },
    );
    const nonces: unknown[] = [];
    const provider = fixtureProvider((body) => {
      nonces.push(body.nonce);
      return Response.json({ id: "fixture-accepted" });
    });
    const queue = new DiscordInstallWelcomeQueue(
      failingStore,
      "fixture-token",
      provider,
    );
    await queue.enqueue(queued);
    const result: unknown = await queue
      .drainOnce()
      .catch((error: unknown) => error);

    await worker.dispose();
    worker = start();
    await worker.ready;
    const store = welcomeStore();
    const marker = await store.get<string>(markerKey);
    const unexpectedRetry = await store.lmove(
      DISCORD_WELCOME_PENDING,
      DISCORD_WELCOME_PROCESSING,
      "right",
      "left",
    );
    const nextOwner = new DiscordInstallWelcomeQueue(
      store,
      "fixture-token",
      provider,
    );
    const recoveredClaim = await nextOwner.drainOnce();
    const drained = !(await nextOwner.drainOnce());
    expect({
      error: result instanceof Error ? result.message : result,
      marker,
      unexpectedRetry,
      recoveredClaim,
      drained,
      finalMarker: await store.get<string>(markerKey),
      sends: nonces.length,
    }).toEqual({
      error: storageError.message,
      marker: scenario.marker,
      unexpectedRetry: null,
      recoveredClaim: scenario.remainingClaim,
      drained: true,
      finalMarker: "1",
      sends: scenario.before ? 2 : 1,
    });
    if (scenario.before) expect(nonces[1]).toBe(nonces[0]);
  }, 30_000);
}

test("lost retry replacement reply retains only the delayed retry after restart", async () => {
  const queued = { ...job("lost-retry-replacement"), attempts: 6 };
  const store = welcomeStore();
  const storageError = new Error(
    "Fixture retry reply lost after SQLite replacement",
  );
  let retainedRetry: string | undefined;
  let sends = 0;
  const provider = fixtureProvider(() => {
    sends++;
    return Response.json({ message: "Fixture rate limit" }, { status: 429 });
  });
  const queue = new DiscordInstallWelcomeQueue(
    welcomeStore({
      after: (input) => {
        if (input.operation !== "requeue") return;
        if (typeof input.value !== "string")
          throw new Error("Missing retry value");
        retainedRetry = input.value;
        throw storageError;
      },
    }),
    "fixture-token",
    provider,
  );
  await queue.enqueue(queued);
  await expect(queue.drainOnce()).rejects.toThrow(storageError.message);
  await worker.dispose();
  worker = start();
  await worker.ready;
  if (!retainedRetry) throw new Error("Missing published retry");
  expect(JSON.parse(retainedRetry)).toEqual({
    ...queued,
    attempts: 7,
    retryAt: expect.any(String),
  });
  const { retryAt } = JSON.parse(retainedRetry) as { retryAt: string };
  expect(Date.parse(retryAt)).toBeGreaterThan(Date.now());
  expect(
    await store.lmove(
      DISCORD_WELCOME_PROCESSING,
      DISCORD_WELCOME_PENDING,
      "right",
      "left",
    ),
  ).toBeNull();
  expect(
    await store.eval(
      DISCORD_WELCOME_REQUEUE,
      [DISCORD_WELCOME_PROCESSING, DISCORD_WELCOME_PENDING],
      [JSON.stringify(queued), retainedRetry],
    ),
  ).toBe(0);
  const recovered = new DiscordInstallWelcomeQueue(
    store,
    "fixture-token",
    provider,
  );
  expect(await recovered.drainOnce()).toBe(true);
  expect(await recovered.drainOnce()).toBe(true);
  expect(sends).toBe(1);
  const retry = await store.lmove(
    DISCORD_WELCOME_PENDING,
    DISCORD_WELCOME_PROCESSING,
    "right",
    "left",
  );
  expect(retry).toBe(retainedRetry);
  expect(
    await store.lmove(
      DISCORD_WELCOME_PENDING,
      DISCORD_WELCOME_PROCESSING,
      "right",
      "left",
    ),
  ).toBeNull();
  expect(await store.lrem(DISCORD_WELCOME_PROCESSING, 1, retainedRetry)).toBe(
    1,
  );
}, 30_000);

test("retry replacement preserves unrelated and duplicate legacy processing members", async () => {
  const store = welcomeStore();
  const selected = JSON.stringify(job("selected-retry"));
  const other = JSON.stringify(job("other-processing"));
  const retry = JSON.stringify({ ...job("selected-retry"), attempts: 1 });
  const replace = (claim: string) =>
    store.eval(
      DISCORD_WELCOME_REQUEUE,
      [DISCORD_WELCOME_PROCESSING, DISCORD_WELCOME_PENDING],
      [claim, retry],
    );
  await store.lpush(DISCORD_WELCOME_PROCESSING, selected, other, selected);
  expect(await replace(`${selected} `)).toBe(0);
  expect(
    await store.lmove(
      DISCORD_WELCOME_PENDING,
      DISCORD_WELCOME_PROCESSING,
      "right",
      "left",
    ),
  ).toBeNull();
  expect(await replace(selected)).toBe(1);
  expect(
    await store.lmove(
      DISCORD_WELCOME_PENDING,
      DISCORD_WELCOME_PROCESSING,
      "right",
      "left",
    ),
  ).toBe(retry);
  expect(await store.lrem(DISCORD_WELCOME_PROCESSING, 0, retry)).toBe(1);
  expect(await store.lrem(DISCORD_WELCOME_PROCESSING, 0, selected)).toBe(1);
  expect(await store.lrem(DISCORD_WELCOME_PROCESSING, 0, other)).toBe(1);
  expect(
    await store.lmove(
      DISCORD_WELCOME_PROCESSING,
      DISCORD_WELCOME_PENDING,
      "right",
      "left",
    ),
  ).toBeNull();
}, 30_000);

test("the same welcome poller resumes its retained claim after the state owner supports atomic retry", async () => {
  const queued = job("compatibility-retained-claim");
  const refusedRead = deferred();
  const sent = deferred();
  let legacy = true;
  let sends = 0;
  const store = welcomeStore({
    after: (input, headers) => {
      if (legacy && input.operation === "get") {
        headers?.delete(DISCORD_WELCOME_REQUEUE_HEADER);
        refusedRead.resolve();
      }
    },
  });
  const queue = new DiscordInstallWelcomeQueue(
    store,
    "fixture-token",
    fixtureProvider(() => {
      sends++;
      sent.resolve();
      return Response.json({ id: "fixture-accepted" });
    }),
  );
  await queue.enqueue(queued);
  try {
    await queue.start();
    await refusedRead.promise;
    await Bun.sleep(0);
    expect(sends).toBe(0);
    legacy = false;
    await sent.promise;
  } finally {
    await queue.stop();
  }
  expect(sends).toBe(1);
  expect(
    await store.get<string>(`${DISCORD_WELCOME_DELIVERED}${queued.id}`),
  ).toBe("1");
  expect(await queue.drainOnce()).toBe(false);
}, 30_000);
