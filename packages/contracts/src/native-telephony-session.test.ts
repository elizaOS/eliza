import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSmsSession,
  mmsProblemLabel,
  mmsReceiptLabel,
  type SmsSessionClient,
  smsReceiptLabel,
} from "./native-telephony-session.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const status = { permissions: { sms: "granted" }, subscriptions: [] };

// The session reads only what it needs; tests pass partial client answers.
function fake(overrides: Record<string, unknown> = {}) {
  let reads = 0;
  let stops = 0;
  const client = {
    smsSendHistory: async () => [],
    status: async () => status,
    threadPage: async () => {
      reads++;
      return { rows: [], next: null };
    },
    messagePage: async () => ({ rows: [], next: null }),
    requestAccess: async () => status,
    markThreadRead: async () => ({ defaultSmsApp: true, updated: 0 }),
    observeMessages: async () => async () => {
      stops++;
    },
    ...overrides,
  } as unknown as SmsSessionClient;
  return {
    client,
    get reads() {
      return reads;
    },
    get stops() {
      return stops;
    },
  };
}

test("off the admitted profile nothing is read; leaving clears memory and stops the observer", async () => {
  const f = fake();
  const off = createSmsSession(f.client, false, () => {});
  off.setActive(true);
  await tick();
  assert.equal(f.reads, 0);
  await off.request("sms");
  const on = createSmsSession(f.client, true, () => {});
  on.setActive(true);
  await tick();
  assert.equal(f.reads, 1);
  on.setActive(false);
  await tick();
  assert.equal(f.stops, 1);
  assert.equal(on.state.status, null);
  assert.deepEqual(on.state.threads, []);
});

test("an old visit's rejection cannot erase fresh rows", async () => {
  let reject: (error: Error) => void = () => {};
  let read = 0;
  const f = fake({
    threadPage: () =>
      ++read === 1
        ? new Promise((_, r) => {
            reject = r;
          })
        : Promise.resolve({ rows: [{ id: "thread:2" }], next: null }),
  });
  const s = createSmsSession(f.client, true, () => {});
  s.setActive(true);
  await tick();
  s.setActive(false);
  s.setActive(true);
  await tick();
  reject(Error("permission revoked in the old visit"));
  await tick();
  assert.deepEqual(s.state.threads, [{ id: "thread:2" }]);
  s.setActive(false);
});

test("denied access and an unreadable provider are distinct from empty; the cursor is forwarded", async () => {
  const cursors: (string | undefined)[] = [];
  const f = fake({
    threadPage: async (cursor?: string) => {
      cursors.push(cursor);
      return {
        rows: [{ id: "thread:3" }],
        next: cursor ? null : "10:thread:3",
      };
    },
  });
  const s = createSmsSession(f.client, true, () => {});
  s.setActive(true);
  await tick();
  await s.refresh(true);
  assert.deepEqual(cursors, [undefined, "10:thread:3"]);
  s.setActive(false);

  const denied = createSmsSession(
    fake({ status: async () => ({ permissions: { sms: "denied" } }) }).client,
    true,
    () => {},
  );
  denied.setActive(true);
  await tick();
  assert.match(denied.state.message, /not been granted/);
  denied.setActive(false);

  const broken = createSmsSession(
    fake({
      threadPage: async () => {
        throw Error("null provider");
      },
    }).client,
    true,
    () => {},
  );
  broken.setActive(true);
  await tick();
  assert.match(broken.state.message, /could not be read completely/);
  broken.setActive(false);

  const named = createSmsSession(fake().client, true, () => {}, {
    messages: { empty: "Nothing here yet." },
  });
  named.setActive(true);
  await tick();
  assert.equal(named.state.message, "Nothing here yet.");
  named.setActive(false);
});

test("switching conversations drops a delayed earlier read", async () => {
  let resolve: (value: unknown) => void = () => {};
  const f = fake({
    messagePage: async (id: string) =>
      id === "thread:1"
        ? new Promise((r) => {
            resolve = r;
          })
        : { rows: [{ id: "sms:2" }], next: null },
  });
  const s = createSmsSession(f.client, true, () => {});
  s.setActive(true);
  await tick();
  s.openThread("thread:1");
  await tick();
  s.openThread("thread:2");
  await tick();
  resolve({ rows: [{ id: "sms:1" }], next: null });
  await tick();
  assert.deepEqual(s.state.rows, [{ id: "sms:2" }]);
  s.setActive(false);
});

test("holding the SMS role, an opened conversation is marked read through the newest shown message only", async () => {
  const rows = [
    { id: "sms:9", direction: "incoming", read: false, date: 1700000000900 },
    { id: "mms:4", direction: "incoming", read: true, date: 1700000000000 },
    { id: "sms:8", direction: "outgoing", read: true, date: 1699999999000 },
  ];
  const run = async (
    held: boolean,
    page: typeof rows,
    answer = async () => ({ defaultSmsApp: true, updated: 1 }),
  ) => {
    const marks: [string, number][] = [];
    const f = fake({
      status: async () => ({ ...status, roles: { sms: { held } } }),
      messagePage: async () => ({ rows: page, next: null }),
      markThreadRead: async (thread: string, through: number) => {
        marks.push([thread, through]);
        return answer();
      },
    });
    const s = createSmsSession(f.client, true, () => {});
    s.setActive(true);
    await tick();
    s.openThread("thread:5");
    await tick();
    await tick();
    const shown = s.state.rows;
    s.setActive(false);
    await tick();
    return { marks, shown };
  };
  assert.deepEqual((await run(true, rows)).marks, [
    ["thread:5", 1700000000900],
  ]);
  assert.deepEqual((await run(false, rows)).marks, []);
  assert.deepEqual(
    (
      await run(
        true,
        rows.map((row) => ({ ...row, read: true })),
      )
    ).marks,
    [],
  );
  assert.deepEqual((await run(true, [])).marks, []);
  const failed = await run(true, rows, async () => {
    throw Error("provider refused");
  });
  assert.equal(failed.marks.length, 1);
  assert.deepEqual(
    failed.shown.map((row) => row.id),
    ["sms:9", "mms:4", "sms:8"],
  );

  const list = createSmsSession(
    fake({
      status: async () => ({ ...status, roles: { sms: { held: true } } }),
      threadPage: async () => ({
        rows: [{ id: "thread:5", unread: true }],
        next: null,
      }),
      markThreadRead: async () => {
        throw Error("the conversation list must not mark");
      },
    }).client,
    true,
    () => {},
  );
  list.setActive(true);
  await tick();
  assert.equal(list.state.threads.length, 1);
  list.setActive(false);
});

test("an old visit's observer stops before a new visit observes; send updates reach the host", async () => {
  let release: () => void = () => {};
  const calls: string[] = [];
  const updates: string[] = [];
  let attempt = 0;
  const f = fake({
    observeMessages: async (
      _change: () => void,
      sms?: (id: string) => void,
      mms?: (id: string) => void,
    ) => {
      const id = ++attempt;
      calls.push(`start${id}`);
      sms?.(`sms-${id}`);
      mms?.(`mms-${id}`);
      if (id === 1)
        await new Promise<void>((r) => {
          release = r;
        });
      return async () => {
        calls.push(`stop${id}`);
      };
    },
  });
  const s = createSmsSession(f.client, true, () => {}, {
    onSendUpdated: (id) => updates.push(id),
    onMmsSendUpdated: (id) => updates.push(id),
  });
  s.setActive(true);
  await tick();
  s.setActive(false);
  s.setActive(true);
  await tick();
  assert.deepEqual(calls, ["start1"]);
  release();
  await tick();
  await tick();
  assert.deepEqual(calls, ["start1", "stop1", "start2"]);
  assert.deepEqual(updates, ["sms-1", "mms-1", "sms-2", "mms-2"]);
  s.setActive(false);
  await tick();
});

test("receipt labels never claim more than the result proves", () => {
  assert.match(smsReceiptLabel("submitted"), /not confirmed/);
  assert.match(smsReceiptLabel("unknown"), /Check the recipient/);
  assert.match(smsReceiptLabel("sent"), /delivery is not confirmed/);
  assert.match(mmsReceiptLabel("sent"), /delivery is not confirmed/);
  assert.match(mmsReceiptLabel("submitted"), /not confirmed/);
  assert.match(mmsProblemLabel("mms-unavailable"), /from this app\./);
  assert.match(mmsProblemLabel("mms-unavailable", "Example"), /from Example\./);
  assert.match(mmsProblemLabel("too-large"), /1 MB/);
});
