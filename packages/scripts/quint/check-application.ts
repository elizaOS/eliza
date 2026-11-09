/** Replays Quint-generated state traces against the application's real reducers. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppStartupStateMachine } from "../../app/src/runtime/startup-state.ts";
import {
  initialOwnerFence,
  ownerFenceStep,
} from "../../host/native-host/task-owner-fence.mjs";
import {
  type DurableDraft,
  replaceDurableDraft,
} from "../../ui/src/state/durable-draft.ts";
import { DraftTranscriptGuard } from "../../ui/src/voice/draft-transcript-guard.ts";
import {
  applyClientAction,
  applyServerEvent,
  beginListening,
  INITIAL_VOICE_SESSION_STATE,
  loopToListening,
} from "../../ui/src/voice/voice-session-state.ts";
import {
  initialWakeWindowState,
  wakeWindowReducer,
} from "../../ui/src/voice/wake-listen-window.ts";
import { testOutputPath } from "../lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(import.meta.url);
const quintPackage = require.resolve("@informalsystems/quint/package.json");
const quint = path.join(path.dirname(quintPackage), "dist/src/cli.js");
const sources = {
  AppStartup: "packages/app/quint/AppStartup.qnt",
  DraftTranscript: "packages/ui/quint/DraftTranscript.qnt",
  DurableDraftCAS: "packages/ui/quint/DurableDraftCAS.qnt",
  WakeListenWindow: "packages/ui/quint/WakeListenWindow.qnt",
  TaskOwnerFence: "packages/host/quint/TaskOwnerFence.qnt",
  VoiceSessionProjection: "packages/ui/quint/VoiceSessionProjection.qnt",
};

type TraceState = Record<string, unknown>;

function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if ("#bigint" in record) {
    const number = Number(record["#bigint"]);
    assert(
      Number.isSafeInteger(number),
      "Trace integer exceeds JavaScript's exact range",
    );
    return number;
  }
  if ("#map" in record) {
    return new Map(
      (record["#map"] as unknown[][]).map(([key, item]) => [
        decode(key),
        decode(item),
      ]),
    );
  }
  if ("#set" in record)
    return new Set((record["#set"] as unknown[]).map(decode));
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, decode(item)]),
  );
}

function replayStartup(states: TraceState[]): void {
  const machine = new AppStartupStateMachine(() => 0);
  for (const [index, state] of states.entries()) {
    if (index > 0) {
      if (state.accepted || state.requested === machine.snapshot.phase) {
        machine.transition(
          state.requested as Parameters<typeof machine.transition>[0],
        );
      } else {
        assert.throws(() =>
          machine.transition(
            state.requested as Parameters<typeof machine.transition>[0],
          ),
        );
      }
    }
    assert.deepEqual(
      {
        phase: machine.snapshot.phase,
        agent: machine.snapshot.agentState,
        attempt: machine.snapshot.attempt,
      },
      { phase: state.phase, agent: state.agent, attempt: state.attempt },
    );
  }
}

function replayDraft(states: TraceState[]): void {
  const guard = new DraftTranscriptGuard();
  const callbacks = new Map<number, ReturnType<typeof guard.begin>>();
  const text = (value: unknown) => (value === 0 ? "" : String(value));
  for (const state of states) {
    switch (state.actionName) {
      case "observe":
        guard.observe(text(state.text));
        break;
      case "invalidate":
        guard.invalidate();
        break;
      case "begin":
        callbacks.set(
          state.callback as number,
          guard.begin((_original, transcript) => transcript),
        );
        break;
      case "deliver": {
        const callback = callbacks.get(state.callback as number);
        assert(callback, "Trace delivered an unknown capture callback");
        assert.equal(
          callback(text(state.text), state.final as boolean).kind,
          state.last,
        );
        break;
      }
      case "init":
        break;
      default:
        throw new Error(`Unknown draft action ${state.actionName}`);
    }
    assert.equal(guard.value, text(state.current));
  }
}

function replayDurableDraft(states: TraceState[]): void {
  const rows = new Map<number, DurableDraft | null>([
    [1, null],
    [2, null],
  ]);
  const receipts = new Map<number, DurableDraft | null>([
    [1, null],
    [2, null],
  ]);
  const text = (value: unknown) => (value === 0 ? "" : String(value));
  for (const state of states) {
    const writer = state.writer as number;
    const binding = state.binding as number;
    const actual = rows.get(binding) ?? null;
    if (state.event === "read") receipts.set(writer, actual);
    if (state.event === "save") {
      const replace = () =>
        replaceDurableDraft(
          actual,
          receipts.get(writer) ?? null,
          String(binding),
          text(state.text),
          {
            revision: () => String(Number(actual?.revision ?? 0) + 1),
            sending: state.mark as boolean,
          },
        );
      if (state.accepted) {
        const replacement = replace();
        rows.set(binding, replacement);
        receipts.set(writer, replacement);
      } else assert.throws(replace);
    }
    const expectedRows = state.rows as Map<
      number,
      { binding: number; revision: number; text: number; sending: boolean }
    >;
    for (const [key, expected] of expectedRows) {
      const row = rows.get(key);
      assert.deepEqual(
        {
          binding: row ? Number(row.binding) : 0,
          revision: Number(row?.revision ?? 0),
          text: row?.text ?? "",
          sending: row?.sending === true,
        },
        {
          binding: expected.binding,
          revision: expected.revision,
          text: text(expected.text),
          sending: expected.sending,
        },
      );
    }
  }
}

function replayWake(states: TraceState[]): void {
  let current = initialWakeWindowState();
  for (const state of states) {
    if (state.event !== "init") {
      const type = state.event === "speech" ? "user-speech-final" : state.event;
      current = wakeWindowReducer(
        current,
        type === "reset"
          ? { type }
          : {
              type: type as
                | "wake"
                | "user-speech-final"
                | "agent-responded"
                | "tick",
              now: state.now as number,
            },
        { idleTimeoutMs: 3, maxWindowMs: 8 },
      );
    }
    assert.deepEqual(current, {
      phase: state.phase,
      openedAt: state.opened,
      awaitingSince: state.awaiting,
    });
  }
}

function replayOwner(states: TraceState[]): void {
  let current = initialOwnerFence;
  for (const state of states) {
    if (state.decision !== "init") {
      const result = ownerFenceStep(
        current,
        state.decision === "retired"
          ? {
              type: state.closed ? "close" : "revoke",
            }
          : {
              type: "read",
              sequence: state.sequence as number,
              startedEpoch: state.started as number,
              account: state.account === 0 ? null : String(state.account),
              confirming: state.confirmed as boolean,
            },
      );
      current = result.fence;
      assert.equal(
        result.decision,
        state.decision === "retired" ? "signed-out" : state.decision,
      );
      assert.equal(result.revoke, state.revoke);
    }
    assert.deepEqual(current, {
      epoch: state.epoch,
      owner: state.owner === 0 ? null : String(state.owner),
      settled: state.settled,
      closed: state.closed,
    });
  }
}

function replayVoice(states: TraceState[]): void {
  let current = { ...INITIAL_VOICE_SESSION_STATE };
  for (const state of states) {
    const traceId = String(state.incoming);
    switch (state.event) {
      case "init":
        current = { ...INITIAL_VOICE_SESSION_STATE };
        break;
      case "connect":
        current = applyClientAction(current, { type: "client/connect" });
        break;
      case "barge":
        current = applyClientAction(current, { type: "client/local_barge_in" });
        break;
      case "listen":
        current = beginListening(current);
        break;
      case "loop":
        current = loopToListening(current);
        break;
      default: {
        const event = {
          ready: { t: "ready", sessionId: "session", traceId },
          partial: { t: "stt_partial", text: "speech", traceId },
          emptyFinal: { t: "stt_final", text: " ", traceId },
          final: { t: "stt_final", text: "speech", traceId },
          llm: { t: "llm_first_text", traceId },
          speakingStart: { t: "speaking_start", traceId },
          speakingEnd: { t: "speaking_end", traceId },
          interrupted: { t: "interrupted", reason: "barge_in", traceId },
          progress: { t: "progress", text: "progress", traceId },
          terminal: { t: "turn_terminal", traceId },
          usage: { t: "usage", traceId },
          error: { t: "error", code: "provider", retryable: true, traceId },
          diagnostic: { t: "assistant_playing", traceId },
          replyComplete: { t: "reply_complete", traceId },
        }[String(state.event)];
        assert(event, `Unknown voice event ${state.event}`);
        current = applyServerEvent(
          current,
          event as Parameters<typeof applyServerEvent>[1],
        );
      }
    }
    assert.deepEqual(
      {
        phase: current.phase,
        trace: current.traceId === null ? 0 : Number(current.traceId),
        cancelled:
          current.progressCancelledTraceId == null
            ? 0
            : Number(current.progressCancelledTraceId),
        progress: Boolean(current.progressText),
        finalNonempty: Boolean(current.finalTranscript),
        interim: Boolean(current.interimTranscript),
        error: Boolean(current.lastError),
      },
      {
        phase: state.phase,
        trace: state.trace,
        cancelled: state.cancelled,
        progress: state.progress,
        finalNonempty: state.finalNonempty,
        interim: state.interim,
        error: state.error,
      },
    );
  }
}

const replayers = {
  AppStartup: replayStartup,
  DraftTranscript: replayDraft,
  DurableDraftCAS: replayDurableDraft,
  WakeListenWindow: replayWake,
  TaskOwnerFence: replayOwner,
  VoiceSessionProjection: replayVoice,
};
const requested = process.argv[2] ? path.resolve(process.argv[2]) : null;
let count = 0;
for (const [name, relative] of Object.entries(sources)) {
  const spec = path.join(root, relative);
  if (requested && requested !== spec) continue;
  const modules =
    name === "DurableDraftCAS" ? [name, "DurableDraftIsolation"] : [name];
  for (const main of modules) {
    const before = count;
    const output = testOutputPath("quint-conformance", main);
    await mkdir(output, { recursive: true });
    const pattern = path.join(output, "trace-{seq}.itf.json");
    const result = spawnSync(
      process.execPath,
      [
        quint,
        "run",
        spec,
        `--main=${main}`,
        "--backend=typescript",
        "--seed=20261107",
        "--max-samples=25",
        "--n-traces=25",
        "--max-steps=80",
        "--invariant=invariant",
        `--out-itf=${pattern}`,
        "--verbosity=0",
      ],
      { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    if (result.error) throw result.error;
    assert.equal(
      result.status,
      0,
      `Quint trace generation failed for ${name}\n${result.stdout}\n${result.stderr}`,
    );
    const files = (await readdir(output)).filter((file) =>
      /^trace-\d+\.itf\.json$/.test(file),
    );
    assert.equal(files.length, 25, `Expected 25 generated traces for ${name}`);
    for (const file of files) {
      const trace = JSON.parse(
        await readFile(path.join(output, file), "utf8"),
      ) as { vars: string[]; states: Array<Record<string, unknown>> };
      assert.equal(trace.vars.length, 1, "Expected one modeled state record");
      const stateVariable = trace.vars[0];
      assert(stateVariable === "s" || stateVariable.endsWith("::s"));
      const states = trace.states.map(
        (row) => decode(row[stateVariable]) as TraceState,
      );
      replayers[name as keyof typeof replayers](states);
      count += states.length - 1;
    }
    const summary = {
      model: relative,
      main,
      seed: 20261107,
      traces: files.length,
      steps: count - before,
      result: "passed",
      includesRejectedAndStutteringSteps: true,
    };
    await writeFile(
      path.join(output, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    console.log(`${main}: 25 Quint traces match the implementation`);
  }
}
assert(
  count > 0,
  `No conformance model matches ${requested ?? "the configured source list"}`,
);
console.log(`Replayed ${count} implementation steps`);
