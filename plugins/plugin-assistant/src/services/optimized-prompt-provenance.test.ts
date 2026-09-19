/** Exercises signed artifact persistence, host binding and the real planner request boundary with deterministic model output. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { plannerTemplate } from "../prompts/planner.ts";
import { runPlannerLoop } from "../runtime/planner-loop.ts";
import {
  type OptimizedPromptArtifact,
  OptimizedPromptService,
  type OptimizedPromptTargetBinding,
  parseOptimizedPromptArtifact,
} from "./optimized-prompt";

const roots: string[] = [];
const target: OptimizedPromptTargetBinding = {
  provider: "cerebras",
  model: "qwen-3.8-27b",
  endpoint: "https://api.cerebras.ai/v1",
  generationConfigSha256: "a".repeat(64),
  runtimeRevision: "b".repeat(40),
};
function artifact(): OptimizedPromptArtifact {
  return {
    task: "action_planner",
    optimizer: "instruction-search",
    baseline: plannerTemplate,
    prompt: "BOUND_CANDIDATE_INSTRUCTION",
    score: 0.8,
    baselineScore: 0.7,
    datasetId: "pilot",
    datasetSize: 3,
    generatedAt: "2026-09-15T00:00:00.000Z",
    lineage: [{ round: 1, variant: 0, score: 0.8 }],
    provenance: {
      schemaVersion: 1,
      target: { ...target },
      optimizerVersion: "gepa==0.1.4",
      optimizerConfigSha256: "c".repeat(64),
      datasetHashes: {
        train: "d".repeat(64),
        validation: "e".repeat(64),
        test: "f".repeat(64),
      },
      evaluationSha256: "1".repeat(64),
    },
  };
}
async function service() {
  vi.stubEnv(
    "ELIZA_OPTIMIZED_PROMPT_HMAC_KEY",
    Buffer.alloc(32, 0x72).toString("base64"),
  );
  const root = await mkdtemp(join(tmpdir(), "prompt-target-"));
  roots.push(root);
  const value = new OptimizedPromptService();
  value.setStoreRoot(root);
  value.setDisabledTasksFromEnv(undefined);
  return value;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it("requires a matching host binding before the real planner dispatches and after restart", async () => {
  let current = await service();
  const value = artifact();
  await current.setPrompt("action_planner", value);
  const useModel = vi.fn(async () => ({ text: "Ready." }));
  const run = () =>
    runPlannerLoop({
      runtime: { getService: () => current, useModel },
      context: { id: "bound-prompt-consumer" },
      evaluate: async () => ({
        success: true,
        decision: "FINISH",
        messageToUser: "Ready.",
      }),
    });
  await expect(run()).rejects.toMatchObject({
    code: "OPTIMIZED_PROMPT_TARGET_MISMATCH",
  });
  expect(useModel).not.toHaveBeenCalled();
  current.setTargetBinding("action_planner", target);
  await run();
  expect(JSON.stringify(useModel.mock.calls)).toContain(value.prompt);
  expect(useModel).toHaveBeenCalledTimes(1);
  const stored = JSON.parse(
    await readFile(
      join(current.getStoreRoot(), "action_planner", "current"),
      "utf8",
    ),
  );
  expect(stored.provenance).toEqual(value.provenance);
  const restarted = new OptimizedPromptService();
  restarted.setStoreRoot(current.getStoreRoot());
  restarted.setDisabledTasksFromEnv(undefined);
  await restarted.refresh();
  current = restarted;
  await expect(run()).rejects.toMatchObject({
    code: "OPTIMIZED_PROMPT_TARGET_MISMATCH",
  });
  expect(useModel).toHaveBeenCalledTimes(1);
  current.setTargetBinding("action_planner", target);
  await run();
  expect(useModel).toHaveBeenCalledTimes(2);
  current.setTargetBinding("action_planner", null);
  await current.restoreBaseline("action_planner");
  await run();
  expect(JSON.stringify(useModel.mock.calls[2])).not.toContain(value.prompt);
});

it.each([
  { provider: "other" },
  { model: "another-model" },
  { endpoint: "https://other.example/v1" },
  { generationConfigSha256: "2".repeat(64) },
  { runtimeRevision: "3".repeat(40) },
])("rejects a changed evaluated target %j", async (change) => {
  const current = await service();
  await current.setPrompt("action_planner", artifact());
  current.setTargetBinding("action_planner", { ...target, ...change });
  expect(() => current.getPrompt("action_planner", plannerTemplate)).toThrow(
    expect.objectContaining({ code: "OPTIMIZED_PROMPT_TARGET_MISMATCH" }),
  );
});

it("copies the host binding and clears it on stop", async () => {
  const current = await service();
  await current.setPrompt("action_planner", artifact());
  const declared = { ...target };
  current.setTargetBinding("action_planner", declared);
  declared.model = "changed-outside-service";
  expect(current.getPrompt("action_planner", plannerTemplate)?.prompt).toBe(
    artifact().prompt,
  );
  await current.stop();
  await current.refresh();
  expect(() => current.getPrompt("action_planner", plannerTemplate)).toThrow(
    expect.objectContaining({ code: "OPTIMIZED_PROMPT_TARGET_MISMATCH" }),
  );
});

it("keeps legacy compatibility and operator disable distinct from a target mismatch", async () => {
  const current = await service();
  const legacy = artifact();
  delete legacy.provenance;
  await current.setPrompt("action_planner", legacy);
  expect(current.getPrompt("action_planner", plannerTemplate)?.prompt).toBe(
    legacy.prompt,
  );
  await current.setPrompt("action_planner", artifact());
  current.setDisabledTasksFromEnv("action_planner");
  expect(current.getPrompt("action_planner", plannerTemplate)).toBeNull();
});

it.each([
  { evaluationSha256: "invalid" },
  { optimizerVersion: "" },
  { schemaVersion: 2 },
  { datasetHashes: { train: "d".repeat(64), validation: "e".repeat(64) } },
  { unexpected: "ignored-proof" },
  { target: { ...target, endpoint: "https://user:password@example.org/v1" } },
  { target: { ...target, endpoint: "https://example.org/v1?api_key=secret" } },
  { target: { ...target, extra: "not-consumed" } },
  { target: { ...target, generationConfigSha256: "" } },
])("rejects incomplete or unconsumed provenance %j", (change) => {
  const value = artifact();
  expect(
    parseOptimizedPromptArtifact({
      ...value,
      provenance: { ...value.provenance, ...change },
    }),
  ).toBeNull();
});

it("rejects invalid evidence before replacing an active signed artifact", async () => {
  const current = await service();
  const good = artifact();
  await current.setPrompt("action_planner", good);
  current.setTargetBinding("action_planner", target);
  const before = await readFile(
    join(current.getStoreRoot(), "action_planner", "current"),
    "utf8",
  );
  const bad = artifact();
  if (!bad.provenance) throw new Error("Missing fixture provenance");
  bad.provenance.optimizerVersion = "";
  await expect(current.setPrompt("action_planner", bad)).rejects.toMatchObject({
    code: "OPTIMIZED_PROMPT_ARTIFACT_INVALID",
  });
  expect(
    await readFile(
      join(current.getStoreRoot(), "action_planner", "current"),
      "utf8",
    ),
  ).toBe(before);
  expect(current.getPrompt("action_planner", plannerTemplate)?.prompt).toBe(
    good.prompt,
  );
});
