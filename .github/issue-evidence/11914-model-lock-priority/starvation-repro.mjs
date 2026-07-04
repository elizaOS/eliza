/**
 * #11914 fail-without-fix repro — interactive starvation on the single local
 * inference lane.
 *
 * BEFORE (arrival-order lane — what the code did): every request piled onto
 * the bionic host's residentLock in arrival order, so an interactive chat
 * turn arriving behind a long background job AND its self-queued next firing
 * waited for the whole backlog.
 *
 * AFTER (InferencePriorityGate, this PR): the interactive turn dispatches
 * ahead of queued background work; a background firing that cannot start
 * within its bounded wait fails typed without ever reaching the host.
 *
 * Timing is scaled: the observed on-device job holds the lock ~5 min per
 * firing; here 1 "device minute" = 60 ms so the repro runs in <2 s.
 *
 * Run from the repo root AFTER `bun run --cwd packages/core build`:
 *   bun .github/issue-evidence/11914-model-lock-priority/starvation-repro.mjs
 */

import {
  InferenceBackgroundWaitTimeoutError,
  InferencePriorityGate,
} from "../../../packages/core/dist/index.node.js";

const DEVICE_MINUTE_MS = 60; // scale: 60ms == 1 minute of device time
const BG_JOB_MINUTES = 5; //   the observed ~5-min background job
const CHAT_MINUTES = 1; //     a normal interactive turn (~55 s on the Pixel 6a)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const minutes = (ms) => (ms / DEVICE_MINUTE_MS).toFixed(1);

/** The pre-fix lane: a plain arrival-order FIFO lock (the Java residentLock). */
class ArrivalOrderLane {
  #tail = Promise.resolve();
  run(fn) {
    const run = this.#tail.then(fn);
    this.#tail = run.then(
      () => {},
      () => {},
    );
    return run;
  }
}

async function scenario(name, runOnLane) {
  const log = [];
  const t0 = Date.now();
  const decode = (label, holdMs) => async () => {
    log.push(`${label} started at +${minutes(Date.now() - t0)}min`);
    await sleep(holdMs);
    log.push(`${label} finished at +${minutes(Date.now() - t0)}min`);
  };

  // t=0: background job takes the lane for 5 "minutes".
  const bg1 = runOnLane("background", decode("bg-job#1", BG_JOB_MINUTES * DEVICE_MINUTE_MS));
  bg1.catch(() => {}); // settled state inspected below via allSettled
  await sleep(DEVICE_MINUTE_MS); // t=1min

  // t=1min: the job's NEXT firing arrives while it is still running.
  const bg2 = runOnLane("background", decode("bg-job#2", BG_JOB_MINUTES * DEVICE_MINUTE_MS));
  bg2.catch(() => {}); // settled state inspected below via allSettled
  await sleep(DEVICE_MINUTE_MS); // t=2min

  // t=2min: the user sends a chat message.
  const chatSentAt = Date.now();
  let chatError = null;
  await runOnLane("interactive", decode("chat-turn", CHAT_MINUTES * DEVICE_MINUTE_MS)).catch(
    (e) => {
      chatError = e;
    },
  );
  const chatLatencyMin = minutes(Date.now() - chatSentAt);

  const results = await Promise.allSettled([bg1, bg2]);
  console.log(`\n=== ${name} ===`);
  for (const line of log) console.log(`  ${line}`);
  for (const [i, r] of results.entries()) {
    if (r.status === "rejected") {
      const typed = r.reason instanceof InferenceBackgroundWaitTimeoutError;
      console.log(
        `  bg-job#${i + 1} FAILED WITHOUT RUNNING (${typed ? "typed bounded-wait timeout → scheduler backoff" : r.reason.message})`,
      );
    }
  }
  console.log(
    chatError
      ? `  chat turn FAILED: ${chatError.message}`
      : `  chat turn user-visible latency: ${chatLatencyMin} device-minutes` +
          ` (decode itself is ${CHAT_MINUTES} min)`,
  );
  return chatLatencyMin;
}

// BEFORE: arrival order — chat waits behind bg1 AND the self-queued bg2.
const fifo = new ArrivalOrderLane();
const before = await scenario("BEFORE — arrival-order residentLock (no gate)", (_p, fn) =>
  fifo.run(fn),
);

// AFTER: the real InferencePriorityGate with the constrained-class bounded
// background wait (scaled: 2 device-minutes).
const gate = new InferencePriorityGate();
const after = await scenario("AFTER — InferencePriorityGate (#11914)", (priority, fn) =>
  gate.runExclusive(
    {
      priority,
      label: priority,
      ...(priority === "background" ? { waitMs: 2 * DEVICE_MINUTE_MS } : {}),
    },
    fn,
  ),
);

console.log("\n=== verdict ===");
console.log(`  BEFORE: chat waited ${before} device-minutes (starved behind the background backlog)`);
console.log(`  AFTER:  chat waited ${after} device-minutes (holder remainder + own decode)`);
if (Number(after) >= Number(before)) {
  console.error("  FAIL: gate did not improve interactive latency");
  process.exit(1);
}
console.log("  PASS: interactive turn completes within its envelope while background work is mid-flight");
