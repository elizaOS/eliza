/**
 * Live-model evidence for #8932: drives the REAL OrchestratorTaskService
 * grilling loop against the live Cerebras model (the same gpt-oss-120b the
 * scenario judge uses). Round 1 claims done with no test output → the live
 * verifier must grill; round 2 re-reports with pasted passing output → verified
 * done. Captures the actual model verdicts + grill text + status transitions and
 * writes a JSON trajectory report. The scenario-runner CLI can't boot in this
 * sandbox, so this produces the live-model artifact directly.
 *
 * Run: bun --conditions=eliza-source plugins/plugin-agent-orchestrator/test/scenarios/_live-grilling-evidence.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import {
  makeGrillingRuntime,
  makeScriptedAcp,
  OrchestratorTaskService,
  seedActiveTask,
  waitFor,
} from "./_helpers/orchestrator-grilling-harness.ts";

const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY ?? "";
const CEREBRAS_BASE = (
  process.env.CEREBRAS_BASE_URL ?? "https://api.cerebras.ai/v1"
).replace(/\/+$/, "");
const MODEL = process.env.CEREBRAS_MODEL ?? "gpt-oss-120b";

if (!CEREBRAS_KEY) {
  console.error(
    "CEREBRAS_API_KEY not set — cannot run the live-model trajectory",
  );
  process.exit(2);
}

const modelCalls: Array<{ promptTail: string; response: string }> = [];

// The verifier model: a REAL Cerebras chat completion. The verifier prompt
// demands a single JSON object {passed, summary, missing}; gpt-oss-120b returns
// it. (makeGrillingRuntime routes the service's useModel here.)
const liveVerifierModel = async (...args: unknown[]) => {
  const opts = args[1] as { prompt?: string } | undefined;
  const prompt = opts?.prompt ?? "";
  const res = await fetch(`${CEREBRAS_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CEREBRAS_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 600,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Cerebras ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content ?? "";
  modelCalls.push({ promptTail: prompt.slice(-400), response: content });
  return content;
};

const baseRuntime = {
  character: { name: "EvidenceRunner" },
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

async function main() {
  const { store, taskId, sessionId } = await seedActiveTask(["tests pass"]);
  const acp = makeScriptedAcp();
  const runtime = makeGrillingRuntime(
    baseRuntime,
    acp.service,
    liveVerifierModel,
  );
  const service = new OrchestratorTaskService(runtime, { store });
  await service.start();

  const rounds: unknown[] = [];
  try {
    // ---- Round 1: claim done with NO test output → must be grilled. ----
    console.log("[round 1] sub-agent reports done with no evidence…");
    acp.emit(sessionId, "task_complete", {
      response: "I implemented the widget and I believe it works.",
    });
    const grilled = await waitFor(() => acp.sent.length > 0, {
      timeoutMs: 45000,
      intervalMs: 250,
    });
    const r1 = await store.getTask(taskId);
    const grillText = acp.sent.at(-1)?.text ?? "";
    rounds.push({
      round: 1,
      completion: "I implemented the widget and I believe it works.",
      liveModelVerdict:
        modelCalls.at(-1)?.response ?? "(no model call captured)",
      grillFired: grilled,
      grillCitesCriterion: /tests pass/i.test(grillText),
      grillExcerpt: grillText.slice(0, 600),
      taskStatusAfter: r1?.task.status,
      autoVerifyAttempts: r1?.task.metadata?.autoVerifyAttempts,
    });
    console.log(
      `[round 1] grillFired=${grilled} status=${r1?.task.status} citesCriterion=${/tests pass/i.test(grillText)}`,
    );

    // ---- Round 2: re-report WITH pasted passing test output → verified done. ----
    // The grill demanded concrete pasted evidence, so the sub-agent now pastes
    // the actual command + test-runner output block (not just a summary line).
    const round2Evidence = [
      "Done — here is the actual test run proving the criterion 'tests pass':",
      "",
      "$ npm test",
      "> widget@1.0.0 test",
      "> vitest run",
      "",
      " ✓ src/widget.test.ts (12 tests) 34ms",
      "   ✓ renders the widget with default props",
      "   ✓ updates on input change",
      "   ✓ handles empty input without throwing",
      "",
      " Test Files  1 passed (1)",
      "      Tests  12 passed (12)",
      "   Duration  1.20s",
      "",
      "All 12 tests pass, 0 failures. The criterion 'tests pass' is met.",
    ].join("\n");
    console.log(
      "[round 2] sub-agent re-reports with pasted test-runner output…",
    );
    acp.emit(sessionId, "task_complete", {
      response: round2Evidence,
    });
    const done = await waitFor(
      async () => (await store.getTask(taskId))?.task.status === "done",
      { timeoutMs: 45000, intervalMs: 250 },
    );
    const r2 = await store.getTask(taskId);
    rounds.push({
      round: 2,
      completion:
        "Done. Ran `npm test` — 12 passing, 0 failing. The widget renders correctly.",
      liveModelVerdict:
        modelCalls.at(-1)?.response ?? "(no model call captured)",
      verifiedDone: done,
      taskStatusAfter: r2?.task.status,
    });
    console.log(`[round 2] verifiedDone=${done} status=${r2?.task.status}`);
  } finally {
    await service.stop().catch(() => undefined);
  }

  const passed =
    (rounds[0] as { grillFired?: boolean })?.grillFired === true &&
    (rounds[0] as { grillCitesCriterion?: boolean })?.grillCitesCriterion ===
      true &&
    (rounds[1] as { verifiedDone?: boolean })?.verifiedDone === true;

  const report = {
    scenario: "orchestrator.grilling-happy-path",
    description:
      "Real OrchestratorTaskService grilling loop judged by the live Cerebras model",
    model: MODEL,
    endpoint: CEREBRAS_BASE,
    platform: `${process.platform} ${process.arch}`,
    runAt: new Date().toISOString(),
    passed,
    rounds,
    modelCalls: modelCalls.length,
  };

  const outDir = "test-results/evidence/8932-orchestrator-scenarios";
  mkdirSync(outDir, { recursive: true });
  const outPath = `${outDir}/live-grilling-trajectory.json`;
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\n=== LIVE GRILLING ${passed ? "PASSED" : "FAILED"} ===`);
  console.log(`report → ${outPath} (${modelCalls.length} live model calls)`);
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error("live grilling evidence run failed:", err);
  process.exit(1);
});
