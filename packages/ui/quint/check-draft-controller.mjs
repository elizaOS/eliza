/** Replay bounded Quint draft protocols through the shipped controller and CAS. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, decode(item)]),
  );
}

function controllerFixture() {
  const rows = new Map([
    ["one", { version: 1, binding: "one", revision: "1", text: "draft" }],
    ["two", null],
  ]);
  let revision = 1;
  let editor = "draft";
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

const protocols = {
  DraftSendRecovery: replaySendRecovery,
  DraftMarkRace: replayMarkRace,
  DraftQueuedHandoff: replayQueuedHandoff,
};
const requested = process.argv[2] && path.resolve(process.argv[2]);
let steps = 0;
for (const [name, replay] of Object.entries(protocols)) {
  const spec = path.join(root, "packages/ui/quint", `${name}.qnt`);
  if (requested && requested !== spec) continue;
  const output = testOutputPath("quint-draft-controller", name);
  await mkdir(output, { recursive: true });
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
      `--max-steps=${name === "DraftMarkRace" ? 4 : name === "DraftQueuedHandoff" ? 9 : 7}`,
      "--invariant=invariant",
      `--out-itf=${path.join(output, "trace-{seq}.itf.json")}`,
      "--verbosity=0",
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
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
