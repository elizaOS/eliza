/** Exercises tool-policy delivery at the real planner request boundary with deterministic model responses and persisted optimized prompts. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { plannerTemplate } from "../../prompts/planner";
import { OptimizedPromptService } from "../../services/optimized-prompt";
import { runPlannerLoop } from "../planner-loop";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function requestInstructions(
  names: string[] | undefined,
  optimized: boolean,
) {
  let service: OptimizedPromptService | null = null;
  if (optimized) {
    const root = await mkdtemp(join(tmpdir(), "planner-tool-policy-"));
    roots.push(root);
    vi.stubEnv("ELIZA_STATE_DIR", root);
    vi.stubEnv(
      "ELIZA_OPTIMIZED_PROMPT_HMAC_KEY",
      Buffer.alloc(32, 0x62).toString("base64"),
    );
    service = new OptimizedPromptService();
    service.setStoreRoot(join(root, "optimized-prompts"));
    service.setDisabledTasksFromEnv(undefined);
    await service.setPrompt("action_planner", {
      task: "action_planner",
      optimizer: "instruction-search",
      baseline: plannerTemplate,
      prompt: "Plan the requested work using authorized tools.",
      score: 0.7,
      baselineScore: 0.6,
      datasetId: "tool-policy-boundary",
      datasetSize: 1,
      generatedAt: "2026-09-27T00:00:00.000Z",
      lineage: [{ round: 1, variant: 0, score: 0.7 }],
    });
  }
  let instructions: string | undefined;
  await runPlannerLoop({
    runtime: {
      getService: () => service,
      useModel: async (
        _type: string,
        params: { messages?: Array<{ role?: string; content?: unknown }> },
      ) => {
        const content = params.messages?.find(
          (message) => message.role === "system",
        )?.content;
        if (typeof content !== "string")
          throw new Error("Planner did not send system instructions");
        instructions = content;
        return {
          text: "Ready.",
          usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
        };
      },
    },
    context: { id: "tool-policy-boundary" },
    tools: names?.map((name) => ({
      name,
      description: "Authorized operation.",
      parameters: { type: "object" as const, properties: {} },
    })),
    executeToolCall: async () => {
      throw new Error("This request must not execute a tool");
    },
    evaluate: async () => ({
      success: true,
      decision: "FINISH" as const,
      messageToUser: "Ready.",
    }),
  });
  if (instructions === undefined)
    throw new Error("Planner made no model request");
  return instructions;
}

for (const optimized of [false, true]) {
  describe(
    optimized ? "persisted optimized planner" : "default planner",
    () => {
      it.each([
        { names: ["TASKS_MANAGE_ISSUES"] },
        { names: ["TASKS_LIST_AGENTS"] },
        { names: ["TERMINAL"] },
        { names: ["GREET_USER", "DISCOVER_ACTIONS"] },
        { names: [] },
      ])("omits unavailable tool policies for $names", async ({ names }) => {
        const instructions = await requestInstructions(names, optimized);
        expect(instructions).not.toContain("Coding delegation is for");
        expect(instructions).not.toContain("Shell tools are for filesystem");
        expect(instructions).not.toContain(
          "For a single live/current/public lookup",
        );
        expect(instructions).toContain(
          "Never invent SHELL/BROWSER/TASKS workarounds",
        );
      });
      it.each(["TASKS", "TASKS_CREATE", "TASKS_SPAWN_AGENT"])(
        "keeps delegation limits with %s without advertising web tools",
        async (name) => {
          const instructions = await requestInstructions([name], optimized);
          expect(instructions).toContain("Coding delegation is for");
          if (name === "TASKS_CREATE")
            expect(instructions).not.toContain("TASKS_SPAWN_AGENT");
          expect(instructions).toContain(
            "Do not delegate a single live/current/public lookup to a coding agent",
          );
          expect(instructions).not.toContain("WEB_FETCH");
          expect(instructions).not.toContain("WEB_SEARCH");
        },
      );
      it.each(["SHELL", "TERMINAL_SHELL"])(
        "keeps shell recall limits with canonical %s",
        async (name) => {
          const instructions = await requestInstructions([name], optimized);
          expect(instructions).toContain("Shell tools are for filesystem");
          expect(instructions).toContain("never chat-message recall");
          expect(instructions).not.toContain("Coding delegation is for");
          expect(instructions).not.toContain(
            "For a single live/current/public lookup",
          );
        },
      );
      it.each(["WEB_FETCH", "WEB_SEARCH"])(
        "advertises only the exposed lookup tool %s",
        async (name) => {
          const instructions = await requestInstructions([name], optimized);
          expect(instructions).toContain(
            "For a single live/current/public lookup",
          );
          expect(instructions).toContain(name);
          expect(instructions).not.toContain(
            name === "WEB_FETCH" ? "WEB_SEARCH" : "WEB_FETCH",
          );
          expect(instructions).not.toContain("Coding delegation is for");
        },
      );
      it("keeps both lookup alternatives when both are exposed", async () => {
        const instructions = await requestInstructions(
          ["WEB_FETCH", "WEB_SEARCH"],
          optimized,
        );
        expect(instructions).toContain(
          "WEB_FETCH with a grounded URL or WEB_SEARCH",
        );
      });
      it("retains all policies when the caller does not specify a tool surface", async () => {
        const instructions = await requestInstructions(undefined, optimized);
        expect(instructions).toContain("Shell tools are for filesystem");
        expect(instructions).toContain("Coding delegation is for");
        expect(instructions).toContain(
          "WEB_FETCH with a grounded URL or WEB_SEARCH",
        );
      });
    },
  );
}
