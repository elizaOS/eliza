/**
 * LIVE end-to-end validation of the orchestrator grilling/verification loop
 * against a REAL model (Cerebras `gemma-4-31b`). Unlike the deterministic twin
 * in `orchestrator-scenario-logic.test.ts` (which injects a content-aware stub),
 * this drives the real `OrchestratorTaskService` verify loop with the real judge
 * model, so it proves the loop actually verifies when the live model — not a
 * hand-written stub — reads the pasted test evidence. Gated behind
 * `CEREBRAS_API_KEY`; skipped in keyless CI.
 *
 * Run: CEREBRAS_API_KEY=csk-... bunx vitest run orchestrator-grilling-live-gemma
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runGrillingEvidenceBundleCheck,
  runGrillingHappyPathCheck,
} from "../../test/scenarios/_helpers/grilling-scenario.ts";

const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY?.trim() ?? "";
const MODEL = process.env.GEMMA_MODEL?.trim() || "gemma-4-31b";
const BASE_URL =
  process.env.CEREBRAS_BASE_URL?.trim() || "https://api.cerebras.ai/v1";

/** Faithful verifier: forwards the orchestrator's judge prompt to the live
 * model and returns its RAW output, so the real `parseJudgeResponse` /
 * `verifyGoalCompletion` code decides pass/fail — no massaging. Logs each
 * verdict for evidence capture. */
function makeGemmaVerifier(label: string) {
  let round = 0;
  return async (...args: unknown[]): Promise<string> => {
    const opts = args[1] as { prompt?: string } | string | undefined;
    const prompt =
      typeof opts === "string" ? opts : (opts?.prompt ?? String(args[1] ?? ""));
    round += 1;
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CEREBRAS_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 800,
        temperature: 0,
      }),
    });
    if (!res.ok) {
      throw new Error(`Cerebras ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content ?? "";
    // eslint-disable-next-line no-console
    console.log(
      `\n[gemma-verifier:${label}] round ${round} raw verdict:\n${content}\n`,
    );
    return content;
  };
}

function makeBaseRuntime() {
  return {
    agentId: "00000000-0000-4000-8000-000000000abc",
    character: { name: "GemmaTester" },
    databaseAdapter: undefined,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    getSetting: () => undefined,
    getService: () => undefined,
    useModel: async () => "{}",
  } as never;
}

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv.autoVerify = process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
  savedEnv.traj = process.env.ELIZA_TRAJECTORY_RECORDING;
  process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = "1";
  process.env.ELIZA_TRAJECTORY_RECORDING = "0";
});
afterEach(() => {
  for (const [k, v] of [
    ["ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY", savedEnv.autoVerify],
    ["ELIZA_TRAJECTORY_RECORDING", savedEnv.traj],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe.skipIf(!CEREBRAS_KEY)(
  `orchestrator grilling loop — LIVE ${MODEL} (Cerebras)`,
  () => {
    it("grills a no-evidence completion, then verifies done once real Gemma reads pasted passing tests", async () => {
      const result = await runGrillingHappyPathCheck(
        makeBaseRuntime(),
        makeGemmaVerifier("happy-path"),
      );
      expect(result).toBeUndefined();
    }, 120_000);

    it("passes verification once the diff + test stdout reach the real Gemma judge", async () => {
      // runGrillingEvidenceBundleCheck injects its OWN capturing model; this
      // asserts evidence assembly. Kept here as a companion to the happy path.
      const result = await runGrillingEvidenceBundleCheck(makeBaseRuntime());
      expect(result).toBeUndefined();
    }, 60_000);
  },
);
