/** Replay bounded Quint draft protocols through the shipped controller and CAS. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

// The controller uses TypeScript parameter properties. Use Node's normal
// transforming loader rather than rewriting the implementation under test.
if (!process.execArgv.includes("--experimental-transform-types")) {
  const child = spawnSync(
    process.execPath,
    [
      "--experimental-transform-types",
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { stdio: "inherit" },
  );
  if (child.error) throw child.error;
  if (child.signal) process.kill(process.pid, child.signal);
  process.exit(child.status ?? 1);
}

const { DurableDraftController } = await import(
  "../src/state/durable-draft-controller.ts"
);
const { DurableDraftTooLarge, replaceDurableDraft } = await import(
  "../src/state/durable-draft.ts"
);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(import.meta.url);
const quint = path.join(
  path.dirname(require.resolve("@informalsystems/quint/package.json")),
  "dist/src/cli.js",
);
const settleQueues = () => new Promise((resolve) => setImmediate(resolve));

function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (!value || typeof value !== "object") return value;
  if ("#bigint" in value) {
    const result = Number(value["#bigint"]);
    assert(Number.isSafeInteger(result));
    return result;
  }
  if ("#set" in value) return new Set(value["#set"].map(decode));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, decode(item)]),
  );
}

function controllerFixture(initialText = "draft") {
  const rows = new Map([
    ["one", { version: 1, binding: "one", revision: "1", text: initialText }],
    ["two", null],
  ]);
  let revision = 1;
  let editor = initialText;
  let fault = "ok";
  let nextWriteGate;
  const store = (binding) => ({
    async read() {
      return rows.get(binding) ?? null;
    },
    async save(expected, text, _signal, write) {
      const gate = nextWriteGate;
      nextWriteGate = undefined;
      if (gate) await gate;
      const failure = fault;
      fault = "ok";
      if (failure === "before")
        throw new Error("Injected pre-write storage failure");
      if (failure === "too-large") throw new DurableDraftTooLarge();
      const row = replaceDurableDraft(
        rows.get(binding) ?? null,
        expected,
        binding,
        text,
        {
          revision: () => String(++revision),
          sending: write?.sending,
        },
      );
      rows.set(binding, row);
      if (failure === "after")
        throw new Error("Injected lost write acknowledgement");
      return row;
    },
  });
  const create = () =>
    new DurableDraftController(
      async (binding) => store(binding),
      () => editor,
      (value) => {
        editor = value;
      },
      () => {},
    );
  let controller = create();
  return {
    rows,
    get controller() {
      return controller;
    },
    get editor() {
      return editor;
    },
    setFault(value) {
      fault = value;
    },
    blockNextWrite() {
      let release;
      nextWriteGate = new Promise((resolve) => {
        release = resolve;
      });
      return () => release();
    },
    externalOne(text) {
      rows.set(
        "one",
        replaceDurableDraft(rows.get("one"), rows.get("one"), "one", text, {
          revision: () => String(++revision),
        }),
      );
    },
    type(value) {
      editor = value;
      controller.edit(value);
    },
    async restart() {
      controller.abandon();
      editor = "";
      controller = create();
      await controller.open("one");
    },
  };
}

async function replaySendRecovery(states) {
  const fixture = controllerFixture();
  await fixture.controller.open("one");
  for (const state of states) {
    switch (state.phase) {
      case 0:
        break;
      case 1:
        fixture.setFault(state.markFault);
        if (state.markFault === "ok") {
          await fixture.controller.hold("draft");
          await assert.rejects(fixture.controller.hold("draft"));
        } else await assert.rejects(fixture.controller.hold("draft"));
        break;
      case 2:
        if (state.held) fixture.type("");
        break;
      case 3:
        if (state.held && state.route !== "none") {
          fixture.controller.retire();
          if (state.route === "other") fixture.type("");
          await fixture.controller.open(state.route === "same" ? "one" : "two");
        }
        break;
      case 4:
        if (state.held && state.typed) fixture.type("later");
        break;
      case 5:
        if (fixture.controller.holding) {
          if (state.settlement === "release") fixture.controller.release();
          else if (state.settlement === "abandon") fixture.controller.abandon();
          else {
            fixture.setFault(state.clearFault);
            await fixture.controller.settle(
              state.settlement === "unknown" ? "unknown" : "dispatched",
            );
          }
        }
        break;
      case 6:
        await fixture.restart();
        break;
      case 7:
        if (fixture.controller.state.unsettled && state.review === "restore")
          fixture.controller.restoreSaved();
        if (fixture.controller.state.unsettled && state.review === "discard")
          fixture.controller.keepCurrent();
        break;
      default:
        throw new Error(`Unsupported recovery phase ${state.phase}`);
    }
    await settleQueues();
    assert.deepEqual(
      {
        editor: fixture.editor,
        saved: fixture.rows.get("one")?.text ?? "",
        marked: fixture.rows.get("one")?.sending === true,
        otherSaved: fixture.rows.get("two")?.text ?? "",
        held: fixture.controller.holding,
        conflict: fixture.controller.state.conflict,
        unsettled: fixture.controller.state.unsettled,
        error: fixture.controller.state.error,
      },
      {
        editor: state.editor === "draft+later" ? "draft\nlater" : state.editor,
        saved: state.saved === "draft+later" ? "draft\nlater" : state.saved,
        marked: state.marked,
        otherSaved: state.otherSaved,
        held: state.held,
        conflict: state.conflict,
        unsettled: state.unsettled,
        error: state.error,
      },
    );
  }
}

async function replayMarkRace(states) {
  const fixture = controllerFixture();
  await fixture.controller.open("one");
  let authority = true;
  let releaseWrite;
  let outcome;
  let holding;
  let previous = -1;
  for (const state of states) {
    if (state.phase !== previous) {
      switch (state.phase) {
        case 0:
          break;
        case 1:
          fixture.setFault(state.markFault);
          releaseWrite = fixture.blockNextWrite();
          holding = fixture.controller
            .hold("draft", () => authority)
            .then(
              () => {
                outcome = "fulfilled";
              },
              () => {
                outcome = "rejected";
              },
            );
          break;
        case 2:
          if (state.change === "edit") fixture.type("later");
          if (["retire", "same", "other"].includes(state.change)) {
            fixture.controller.retire();
            fixture.type("");
            if (state.change !== "retire")
              await fixture.controller.open(
                state.change === "same" ? "one" : "two",
              );
          }
          if (state.change === "authority") authority = false;
          if (state.change === "external") fixture.externalOne("foreign");
          break;
        case 3:
          releaseWrite();
          await holding;
          assert.equal(outcome, state.fulfilled ? "fulfilled" : "rejected");
          break;
        case 4:
          if (state.postEdit && state.change === "same") fixture.type("later");
          break;
        default:
          throw new Error(`Unsupported mark race phase ${state.phase}`);
      }
    }
    await settleQueues();
    assert.deepEqual(
      {
        editor: fixture.editor,
        saved: fixture.rows.get("one")?.text ?? "",
        marked: fixture.rows.get("one")?.sending === true,
        otherSaved: fixture.rows.get("two")?.text ?? "",
        held: fixture.controller.holding,
        conflict: fixture.controller.state.conflict,
        unsettled: fixture.controller.state.unsettled,
      },
      {
        editor: state.editor,
        saved: state.saved,
        marked: state.marked,
        otherSaved: state.otherSaved,
        held: state.held,
        conflict: state.conflict,
        unsettled: state.unsettled,
      },
    );
    previous = state.phase;
  }
}

function queuedHandoffFixture() {
  const rows = new Map([
    ["one", null],
    ["two", null],
  ]);
  const writes = new Map();
  const reads = [];
  let editor = "";
  let revision = 0;
  let nextOwner = 0;
  let activeOwner = 0;
  let pauseWrites = true;
  let pauseReads = false;
  const controller = new DurableDraftController(
    async (key) => {
      const owner = ++nextOwner;
      activeOwner = owner;
      let conflictRead = false;
      return {
        async read() {
          if (conflictRead) {
            conflictRead = false;
            return rows.get(key);
          }
          if (!pauseReads) return rows.get(key);
          let release;
          const request = { key, failed: false, release: () => release() };
          const gate = new Promise((resolve) => {
            release = resolve;
          });
          reads.push(request);
          await gate;
          if (request.failed) throw new Error("Injected readback failure");
          return rows.get(key);
        },
        async save(expected, text, _signal, write) {
          let request;
          if (pauseWrites) {
            let release;
            const gate = new Promise((resolve) => {
              release = resolve;
            });
            request = { failed: false, release: () => release() };
            writes.set(owner, request);
            await gate;
          }
          try {
            if (request?.failed)
              throw new Error("Injected queued-write failure");
            const row = replaceDurableDraft(
              rows.get(key),
              expected,
              key,
              text,
              {
                revision: () => String(++revision),
                sending: write?.sending,
              },
            );
            rows.set(key, row);
            return row;
          } catch (error) {
            conflictRead = owner === activeOwner;
            throw error;
          }
        },
      };
    },
    () => editor,
    (value) => {
      editor = value;
    },
    () => {},
  );
  return {
    controller,
    rows,
    get editor() {
      return editor;
    },
    type(text) {
      editor = text;
      controller.edit(text);
    },
    retire() {
      activeOwner = 0;
      controller.retire();
      editor = "";
    },
    beginReads() {
      pauseReads = true;
    },
    finishWrite(owner, failed) {
      const request = writes.get(owner);
      assert(request, `No queued write for binding ${owner}`);
      writes.delete(owner);
      request.failed = failed;
      request.release();
      if (writes.size === 0) pauseWrites = false;
    },
    finishRead(failed) {
      const request = reads.shift();
      assert(request, "No pending flush readback");
      request.failed = failed;
      request.release();
    },
    mutate(kind) {
      if (kind === "edit") this.type("newer");
      if (kind === "retire") this.retire();
      if (kind === "revision" || kind === "marked") {
        const key = reads[0]?.key;
        assert(key, "No readback target for external mutation");
        const row = rows.get(key);
        assert(row, "Readback target has no persisted row");
        rows.set(key, {
          ...row,
          revision: String(++revision),
          ...(kind === "marked" ? { sending: true } : {}),
        });
      }
    },
  };
}

async function replayQueuedHandoff(states) {
  const fixture = queuedHandoffFixture();
  await fixture.controller.open("one");
  let flushResult = "not-started";
  let flushing;
  let previous = -1;
  for (const state of states) {
    if (state.phase !== previous) {
      switch (state.phase) {
        case 0:
          break;
        case 1:
          fixture.type("old");
          break;
        case 2:
          fixture.retire();
          await fixture.controller.open(state.sameStore ? "one" : "two");
          fixture.type("new");
          break;
        case 3:
          fixture.beginReads();
          flushResult = "pending";
          flushing = fixture.controller.flush().then(
            () => {
              flushResult = "fulfilled";
            },
            () => {
              flushResult = "rejected";
            },
          );
          break;
        case 4:
          fixture.finishWrite(
            state.first,
            state.first === 1 ? state.failOld : state.failNew,
          );
          break;
        case 5: {
          const second = state.first === 1 ? 2 : 1;
          fixture.finishWrite(
            second,
            second === 1 ? state.failOld : state.failNew,
          );
          break;
        }
        case 6:
          if (
            flushResult === "pending" &&
            !(state.mutationAfterFirst && !state.sameStore)
          )
            fixture.mutate(state.mutation);
          break;
        case 7:
          if (flushResult === "pending")
            fixture.finishRead(state.readFailure === 1);
          break;
        case 8:
          if (
            flushResult === "pending" &&
            state.mutationAfterFirst &&
            !state.sameStore
          )
            fixture.mutate(state.mutation);
          break;
        case 9:
          if (flushResult === "pending")
            fixture.finishRead(state.readFailure === 2);
          await flushing;
          break;
        default:
          throw new Error(`Unsupported queued handoff phase ${state.phase}`);
      }
    }
    await settleQueues();
    assert.deepEqual(
      {
        editor: fixture.editor,
        savedOne: fixture.rows.get("one")?.text ?? "",
        savedTwo: fixture.rows.get("two")?.text ?? "",
        markedOne: fixture.rows.get("one")?.sending === true,
        markedTwo: fixture.rows.get("two")?.sending === true,
        result: flushResult,
        conflict: fixture.controller.state.conflict,
      },
      {
        editor: state.editor,
        savedOne: state.savedOne,
        savedTwo: state.savedTwo,
        markedOne: state.markedOne,
        markedTwo: state.markedTwo,
        result: state.result,
        conflict: state.conflict,
      },
    );
    previous = state.phase;
  }
}

async function replayOpenRecovery(states) {
  const initial = states[0];
  let editor = initial.editor;
  let factoryCalls = 0;
  let readCalls = 0;
  let pendingFactory;
  let pendingRead;
  let timer;
  let elapsed = 0;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay) => {
    assert.equal(timer, undefined, "Only one retry timer may be pending");
    timer = { callback, delay };
    elapsed = 0;
    return 1;
  };
  const row = {
    version: 1,
    binding: "one",
    revision: "1",
    text: "saved",
    ...(initial.marked ? { sending: true } : {}),
  };
  const store = {
    read() {
      readCalls++;
      return new Promise((resolve, reject) => {
        pendingRead = { resolve, reject };
      });
    },
    async save(expected, text) {
      return replaceDurableDraft(row, expected, "one", text, {
        revision: () => "2",
      });
    },
  };
  const controller = new DurableDraftController(
    () => {
      factoryCalls++;
      return new Promise((resolve, reject) => {
        pendingFactory = { resolve, reject };
      });
    },
    () => editor,
    (value, expected, current) => {
      if (editor === expected && current()) editor = value;
    },
    () => {},
  );
  const opening = controller.open("one");
  try {
    for (let index = 0; index < states.length; index++) {
      const state = states[index];
      const previous = states[index - 1];
      if (index > 0 && previous.phase !== "done") {
        switch (state.event) {
          case "factory-opened":
            assert(pendingFactory);
            pendingFactory.resolve(store);
            pendingFactory = undefined;
            break;
          case "factory-failed":
            assert(pendingFactory);
            pendingFactory.reject(new Error("Factory unavailable"));
            pendingFactory = undefined;
            break;
          case "read-opened":
            assert(pendingRead);
            pendingRead.resolve(row);
            pendingRead = undefined;
            break;
          case "read-failed":
            assert(pendingRead);
            pendingRead.reject(new Error("Read unavailable"));
            pendingRead = undefined;
            break;
          case "before-deadline":
            assert(timer);
            elapsed = timer.delay - 1;
            break;
          case "retry": {
            assert(timer);
            assert(elapsed < timer.delay);
            const callback = timer.callback;
            timer = undefined;
            callback();
            break;
          }
          case "edit":
            editor = "typed";
            controller.edit(editor);
            break;
          case "join":
            assert.equal(controller.open("one"), opening);
            break;
          case "retire":
            controller.retire();
            editor = "other";
            controller.edit(editor);
            break;
          default:
            throw new Error(`Unexpected opening event ${state.event}`);
        }
      }
      await settleQueues();
      assert.deepEqual(
        {
          editor,
          factoryCalls,
          readCalls,
          retryMs: timer?.delay ?? 0,
          opening: controller.state.opening,
          conflict: controller.state.conflict,
          unsettled: controller.state.unsettled,
          failed: controller.state.error || controller.state.conflict,
        },
        {
          editor: state.editor,
          factoryCalls: state.factoryCalls,
          readCalls: state.readCalls,
          retryMs: state.retryMs,
          opening: state.opening,
          conflict: state.conflict,
          unsettled: state.unsettled,
          failed: state.failed,
        },
        `Opening trace state ${index} (${state.event})`,
      );
    }
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

async function replayRestoreOwnership(states) {
  const mode = states[0].mode;
  let editor = mode === "review" ? "typed" : mode === "open" ? "" : "saved";
  let row = { version: 1, binding: "one", revision: "1", text: "saved" };
  let revision = 1;
  let authority = true;
  let storageFault = "ok";
  let update;
  let result = "pending";
  const store = {
    async read() {
      return row;
    },
    async save(expected, text, _signal, write) {
      if (storageFault === "before") throw new Error("Store unavailable");
      row = replaceDurableDraft(row, expected, "one", text, {
        revision: () => String(++revision),
        sending: write?.sending,
      });
      if (storageFault === "after")
        throw new Error("Write acknowledgement lost");
      return row;
    },
  };
  const controller = new DurableDraftController(
    async () => store,
    () => editor,
    (text, expected, current) =>
      new Promise((resolve, reject) => {
        update = {
          apply() {
            if (current() && editor === expected) editor = text;
          },
          resolve,
          reject,
        };
      }),
    () => {},
  );
  let operation;
  if (mode === "open") operation = controller.open("one");
  else {
    await controller.open("one");
    if (mode === "review") operation = controller.restoreSaved();
    else if (mode === "consume")
      operation = controller.consume("saved", () => authority);
    else {
      await controller.hold("saved");
      editor = "";
      controller.edit(editor);
      storageFault = states[0].storageFault;
      operation = controller.release();
    }
  }
  const completion = Promise.resolve(operation).then(
    () => {
      result = "fulfilled";
    },
    () => {
      result = "rejected";
    },
  );
  for (let index = 0; index < states.length; index++) {
    const state = states[index];
    const previous = states[index - 1];
    if (index > 0 && !(previous.acknowledged && previous.applied)) {
      switch (state.event) {
        case "apply":
          update.apply();
          break;
        case "acknowledge":
          update.resolve();
          break;
        case "reject":
          update.reject(new Error("Host update rejected"));
          break;
        case "edit":
          editor = "new";
          controller.edit(editor);
          break;
        case "retire":
          controller.retire();
          editor = "other";
          controller.edit(editor);
          break;
        case "keep":
          controller.keepCurrent();
          break;
        case "revoke":
          authority = false;
          break;
        default:
          throw new Error(`Unsupported restore event ${state.event}`);
      }
    }
    await settleQueues();
    assert(update, "A host update must be pending");
    if (state.acknowledged) await completion;
    assert.deepEqual(
      {
        editor,
        saved: row.text,
        marked: row.sending === true,
        unsettled: controller.state.unsettled,
        holding: controller.holding,
        consuming: controller.state.consuming,
        opening: controller.state.opening,
        conflict: controller.state.conflict,
        error: controller.state.error,
        result,
      },
      {
        editor: state.editor,
        saved: state.saved === "saved+new" ? "saved\nnew" : state.saved,
        marked: state.marked,
        unsettled: state.unsettled,
        holding: state.holding,
        consuming: state.consuming,
        opening: state.opening,
        conflict: state.conflict,
        error: state.error,
        result: state.result,
      },
      `Restore ${mode}, state ${index} (${state.event})`,
    );
    if (!state.acknowledged && state.active) {
      await assert.rejects(controller.hold(editor));
      if (mode !== "open") await assert.rejects(controller.flush());
    }
  }
}

async function replayConsumeRollback(states) {
  let editor = "saved";
  let row = { version: 1, binding: "one", revision: "0", text: "saved" };
  let revision = 0;
  let authority = true;
  let readFailure = false;
  let result = "not-started";
  let completion;
  const writes = [];
  const store = {
    async read() {
      if (readFailure) throw new Error("Review read failed");
      return row;
    },
    save(expected, text) {
      return new Promise((resolve, reject) => {
        writes.push({ expected, text, resolve, reject });
      });
    },
  };
  const controller = new DurableDraftController(
    async () => store,
    () => editor,
    (text, expected, current) => {
      if (current() && editor === expected) editor = text;
    },
    () => {},
  );
  await controller.open("one");
  function externalWrite() {
    row = replaceDurableDraft(row, row, "one", "external", {
      revision: () => String(++revision),
    });
  }
  function finishWrite(fault) {
    const write = writes.shift();
    assert(write, "A store write must be pending");
    try {
      if (fault === "before") throw new Error("Store rejected before write");
      row = replaceDurableDraft(row, write.expected, "one", write.text, {
        revision: () => String(++revision),
      });
      if (fault === "after") throw new Error("Write acknowledgement lost");
      write.resolve(row);
    } catch (error) {
      write.reject(error);
    }
  }
  for (let index = 0; index < states.length; index++) {
    const state = states[index];
    const previous = states[index - 1];
    if (index > 0 && previous.phase !== 5) {
      switch (state.event) {
        case "begin":
          result = "pending";
          completion = controller
            .consume("saved", () => authority)
            .then(
              () => {
                result = "fulfilled";
              },
              () => {
                result = "rejected";
              },
            );
          break;
        case "interleave":
          if (state.mutation === "edit") {
            editor = "new";
            controller.edit(editor);
          } else if (state.mutation === "retire") {
            controller.retire();
            editor = "other";
            controller.edit(editor);
          } else if (state.mutation === "revoke") authority = false;
          else if (state.mutation === "external") externalWrite();
          break;
        case "finish-clear":
          readFailure = state.readFailure;
          finishWrite(state.clearFault);
          break;
        case "external-rollback":
          externalWrite();
          break;
        case "wait-rollback":
          break;
        case "finish-rollback":
          finishWrite(state.rollbackFault);
          break;
        default:
          throw new Error(`Unexpected consume event ${state.event}`);
      }
    }
    await settleQueues();
    if (state.phase === 5) await completion;
    assert.deepEqual(
      {
        editor,
        saved: row.text,
        revision,
        result,
        consuming: controller.state.consuming,
        conflict: controller.state.conflict,
        error: controller.state.error,
      },
      {
        editor: state.editor,
        saved: state.saved,
        revision: state.revision,
        result: state.result,
        consuming: state.consuming,
        conflict: state.conflict,
        error: state.error,
      },
      `Consume state ${index} (${state.event})`,
    );
  }
}

async function replayRepeatedSend(states) {
  const fixture = controllerFixture("first");
  await fixture.controller.open("one");
  let authority = true;
  let accepted = 0;
  let rejected = 0;
  let marking;
  let releaseMark;
  for (let index = 0; index < states.length; index++) {
    const state = states[index];
    const previous = states[index - 1];
    if (index > 0 && !(previous.phase === 4 && previous.round === 1)) {
      switch (state.event) {
        case "begin": {
          releaseMark = fixture.blockNextWrite();
          const expected = fixture.editor;
          const count = (operation) =>
            operation.then(
              () => {
                accepted++;
              },
              () => {
                rejected++;
              },
            );
          marking = Promise.all([
            count(fixture.controller.hold(expected, () => authority)),
            count(fixture.controller.hold(expected, () => authority)),
          ]);
          break;
        }
        case "interleave":
          if (state.mutation === "edit") fixture.type("new");
          if (state.mutation === "revoke") authority = false;
          break;
        case "finish-mark":
          fixture.setFault(state.fault);
          releaseMark();
          await marking;
          if (accepted) fixture.type("");
          break;
        case "settle":
          if (fixture.controller.holding) {
            if (state.editor === "new" || state.editor.endsWith("+new"))
              fixture.type("new");
            await fixture.controller.settle(state.outcome);
          }
          break;
        case "next-round":
          await fixture.controller.retry();
          if (fixture.controller.state.conflict)
            fixture.controller.keepCurrent();
          await settleQueues();
          fixture.type("second");
          accepted = 0;
          rejected = 0;
          authority = true;
          break;
        default:
          throw new Error(`Unexpected repeated-send event ${state.event}`);
      }
    }
    await settleQueues();
    const text = (value) => value.replace("+new", "\nnew");
    assert.deepEqual(
      {
        editor: fixture.editor,
        saved: fixture.rows.get("one").text,
        marked: fixture.rows.get("one").sending === true,
        held: fixture.controller.holding,
        conflict: fixture.controller.state.conflict,
        accepted,
        rejected,
      },
      {
        editor: text(state.editor),
        saved: text(state.saved),
        marked: state.marked,
        held: state.held,
        conflict: state.conflict,
        accepted: state.accepted,
        rejected: state.rejected,
      },
      `Repeated send state ${index} (${state.event})`,
    );
  }
}

async function replayConsumeHandoff(states) {
  const fixture = controllerFixture("draft");
  await fixture.controller.open("one");
  const controller = fixture.controller;
  let consume = "not-started";
  let flush = "not-started";
  let consuming;
  let flushing;
  let releaseClear;
  let releaseRollback;
  for (let index = 0; index < states.length; index++) {
    const state = states[index];
    const previous = states[index - 1];
    if (index > 0 && previous.phase !== 8) {
      switch (state.event) {
        case "begin":
          releaseClear = fixture.blockNextWrite();
          consume = "pending";
          consuming = controller.consume("draft").then(
            () => {
              consume = "fulfilled";
            },
            () => {
              consume = "rejected";
            },
          );
          break;
        case "rebind":
          controller.retire();
          fixture.type(state.sameKey ? "draft" : "");
          await controller.open(state.sameKey ? "one" : "two");
          break;
        case "flush":
          flush = "pending";
          flushing = controller.flush().then(
            () => {
              flush = "fulfilled";
            },
            () => {
              flush = "rejected";
            },
          );
          break;
        case "finish-clear":
          releaseRollback = fixture.blockNextWrite();
          releaseClear();
          break;
        case "finish-rollback":
          fixture.setFault(state.rollbackFault);
          releaseRollback();
          await consuming;
          await flushing;
          break;
        case "retry":
          await controller.retry();
          break;
        case "write-new":
          if (controller.state.conflict) controller.keepCurrent();
          await settleQueues();
          fixture.type("new");
          break;
        case "flush-again":
          flush = await controller.flush().then(
            () => "fulfilled",
            () => "rejected",
          );
          break;
        default:
          throw new Error(`Unexpected consume handoff event ${state.event}`);
      }
    }
    await settleQueues();
    assert.deepEqual(
      {
        editor: fixture.editor,
        saved: fixture.rows.get("one").text,
        otherSaved: fixture.rows.get("two")?.text ?? "",
        consume,
        flush,
        conflict: controller.state.conflict,
      },
      {
        editor: state.editor,
        saved: state.saved,
        otherSaved: state.otherSaved,
        consume: state.consume,
        flush: state.flush,
        conflict: state.conflict,
      },
      `Consume handoff state ${index} (${state.event})`,
    );
  }
}

async function replayConsumeRetention(states) {
  const initial = states[0];
  let editor = "reviewed";
  let row = { version: 1, binding: "one", revision: "0", text: editor };
  let revision = 0;
  let writes = 0;
  let update;
  let inlineRestore = false;
  let consumeResult = "pending";
  let consuming;
  const store = {
    async read() {
      if (writes >= 2 && initial.readFailure)
        throw new Error("Conflict readback failed");
      return row;
    },
    async save(expected, text) {
      writes++;
      if (writes === 2 && initial.fault === "before")
        throw new Error("Rollback failed before write");
      if (writes === 2 && initial.fault === "external") {
        row = replaceDurableDraft(row, row, "one", "external", {
          revision: () => String(++revision),
        });
        throw new Error("Another writer replaced the clear");
      }
      row = replaceDurableDraft(row, expected, "one", text, {
        revision: () => String(++revision),
      });
      if (writes === 2 && initial.fault === "after")
        throw new Error("Rollback acknowledgement lost");
      return row;
    },
  };
  const controller = new DurableDraftController(
    async () => store,
    () => editor,
    (text, expected, current) => {
      if (inlineRestore) {
        if (current() && editor === expected) editor = text;
        return;
      }
      return new Promise((resolve, reject) => {
        update = { text, expected, current, resolve, reject };
      });
    },
    () => {},
  );
  await controller.open("one");
  const review = async (choice) => {
    if (choice === "restore") await controller.restoreSaved();
    if (choice === "keep") controller.keepCurrent();
  };
  for (let index = 0; index < states.length; index++) {
    const state = states[index];
    const previous = states[index - 1];
    if (index > 0 && previous.phase !== 4) {
      switch (state.event) {
        case "begin":
          consuming = controller.consume("reviewed").then(
            () => {
              consumeResult = "fulfilled";
            },
            () => {
              consumeResult = "rejected";
            },
          );
          break;
        case "host-rejected":
          assert(update.current() && editor === update.expected);
          editor = update.text;
          update.reject(new Error("Host rejected after applying"));
          await consuming;
          inlineRestore = true;
          break;
        case "review":
          await review(state.choice);
          break;
        case "review-again":
          if (
            previous.choice !== "none" &&
            previous.conflict &&
            previous.offered === "external"
          )
            await review(state.secondChoice);
          break;
        default:
          throw new Error(`Unknown retained-consume event ${state.event}`);
      }
    }
    await settleQueues();
    if (state.phase >= 2) assert.equal(consumeResult, "rejected");
    assert.deepEqual(
      {
        editor,
        stored: row.text,
        offered: controller.state.savedText,
        conflict: controller.state.conflict,
        error: controller.state.error,
        consuming: controller.state.consuming,
      },
      {
        editor: state.editor,
        stored: state.stored,
        offered: state.offered,
        conflict: state.conflict,
        error: state.error,
        consuming: state.consuming,
      },
      `Consume retention state ${index} (${state.event})`,
    );
  }
}

async function replayRetiredConsumeRecovery(states) {
  const initial = states[0];
  let editor = "draft";
  let row = { version: 1, binding: "one", revision: "0", text: "draft" };
  let revision = 0;
  let owners = 0;
  let consume = "idle";
  let flush = "idle";
  let consuming;
  const gates = new Map();
  const releases = new Map();
  for (const name of ["clear", "rollback", "newer"]) {
    gates.set(
      name,
      new Promise((resolve) => {
        releases.set(name, resolve);
      }),
    );
  }
  const controller = new DurableDraftController(
    async () => {
      const owner = ++owners;
      let writes = 0;
      return {
        async read() {
          return row;
        },
        async save(expected, text) {
          writes++;
          if (owner === 1) {
            await gates.get(writes === 1 ? "clear" : "rollback");
            if (writes === 2 && !initial.rollbackAfter)
              throw new Error("Rollback unavailable before write");
          } else if (text === "newer") await gates.get("newer");
          row = replaceDurableDraft(row, expected, "one", text, {
            revision: () => String(++revision),
          });
          if (owner === 1 && writes === 2)
            throw new Error("Rollback acknowledgement lost");
          return row;
        },
      };
    },
    () => editor,
    (text, expected, current) => {
      if (current() && editor === expected) editor = text;
    },
    () => {},
  );
  await controller.open("one");
  const type = (text) => {
    editor = text;
    controller.edit(text);
  };
  for (let index = 0; index < states.length; index++) {
    const state = states[index];
    if (index > 0 && states[index - 1].phase !== 8) {
      switch (state.phase) {
        case 1:
          consume = "pending";
          consuming = controller.consume("draft").then(
            () => {
              consume = "fulfilled";
            },
            () => {
              consume = "rejected";
            },
          );
          break;
        case 2:
          if (state.typed) type("edited");
          controller.retire();
          if (state.mode === "newer") {
            await controller.open("one");
            type("newer");
          } else type("");
          break;
        case 3:
          if (state.mode === "newer" && state.newerFirst)
            releases.get("newer")();
          else {
            releases.get("clear")();
            await settleQueues();
            if (state.mode === "recover") {
              if (state.early) {
                if (state.equalEditor) type(state.typed ? "edited" : "draft");
                await controller.open("one");
              }
            } else {
              releases.get("rollback")();
              await consuming;
            }
          }
          break;
        case 4:
          if (state.mode === "recover") {
            releases.get("rollback")();
            await consuming;
            if (!state.early) {
              if (state.equalEditor) type(state.typed ? "edited" : "draft");
              await controller.open("one");
            }
          } else if (state.newerFirst) {
            releases.get("clear")();
            await consuming;
          } else releases.get("newer")();
          break;
        case 5:
          if (state.mode === "recover") await controller.restoreSaved();
          else if (controller.state.conflict) controller.keepCurrent();
          break;
        case 6:
        case 8:
          flush = await controller.flush().then(
            () => "fulfilled",
            () => "rejected",
          );
          break;
        case 7:
          controller.retire();
          type("");
          await controller.open("one");
          flush = "idle";
          break;
        default:
          throw new Error(`Unknown retired consume phase ${state.phase}`);
      }
    }
    await settleQueues();
    assert.deepEqual(
      {
        editor,
        stored: row.text,
        offered: controller.state.savedText,
        conflict: controller.state.conflict,
        error: controller.state.error,
        consuming: controller.state.consuming,
        consume,
        flush,
      },
      {
        editor: state.editor,
        stored: state.stored,
        offered: state.offered,
        conflict: state.conflict,
        error: state.error,
        consuming: state.consuming,
        consume: state.consume,
        flush: state.flush,
      },
      `Retired consume ${state.mode}, phase ${state.phase}`,
    );
  }
}

const protocols = {
  DraftSendRecovery: replaySendRecovery,
  DraftMarkRace: replayMarkRace,
  DraftQueuedHandoff: replayQueuedHandoff,
  DraftOpenRecovery: replayOpenRecovery,
  DraftRestoreOwnership: replayRestoreOwnership,
  DraftConsumeRollback: replayConsumeRollback,
  DraftRepeatedSend: replayRepeatedSend,
  DraftConsumeHandoff: replayConsumeHandoff,
  DraftConsumeRetention: replayConsumeRetention,
  DraftRetiredConsumeRecovery: replayRetiredConsumeRecovery,
};
const requested = process.argv[2] && path.resolve(process.argv[2]);
let steps = 0;
for (const [name, replay] of Object.entries(protocols)) {
  const spec = path.join(root, "packages/ui/quint", `${name}.qnt`);
  if (requested && requested !== spec) continue;
  const parent = testOutputPath("quint-draft-controller", name);
  await mkdir(parent, { recursive: true });
  const output = await mkdtemp(path.join(parent, "run-"));
  const maxSteps = {
    DraftMarkRace: 4,
    DraftQueuedHandoff: 9,
    DraftOpenRecovery: 20,
    DraftRestoreOwnership: 10,
    DraftConsumeRollback: 5,
    DraftRepeatedSend: 9,
    DraftConsumeHandoff: 8,
    DraftConsumeRetention: 4,
    DraftRetiredConsumeRecovery: 8,
    DraftSendRecovery: 7,
  }[name];
  const result = spawnSync(
    process.execPath,
    [
      quint,
      "run",
      spec,
      "--backend=typescript",
      "--seed=20261107",
      "--max-samples=256",
      "--n-traces=256",
      `--max-steps=${maxSteps}`,
      "--invariant=invariant",
      `--out-itf=${path.join(output, "trace-{seq}.itf.json")}`,
      "--verbosity=0",
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  assert.equal(
    result.status,
    0,
    `Quint trace generation failed\n${result.stdout}\n${result.stderr}`,
  );
  const files = (await readdir(output)).filter((file) =>
    /^trace-\d+\.itf\.json$/.test(file),
  );
  assert.equal(files.length, 256);
  for (const file of files) {
    const trace = JSON.parse(await readFile(path.join(output, file), "utf8"));
    assert.equal(trace.vars.length, 1);
    const states = trace.states.map((row) => decode(row[trace.vars[0]]));
    assert.equal(states.length, maxSteps + 1);
    await replay(states);
    steps += states.length - 1;
  }
  await writeFile(
    path.join(output, "summary.json"),
    `${JSON.stringify({ model: name, traces: files.length, result: "passed" }, null, 2)}\n`,
  );
  console.log(`${name}: ${files.length} traces match the real controller`);
}
assert(steps > 0, `No draft protocol matches ${requested}`);
console.log(`Replayed ${steps} draft controller steps`);
