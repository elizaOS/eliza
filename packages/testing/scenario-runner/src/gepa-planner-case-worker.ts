/** One isolated, read-only planner run. Complete HTTP evidence is required before publication. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JSONSchema, PlannerRuntime } from "@elizaos/core";
import { resolveAliasedEnvValue } from "@elizaos/core/config/boot-config-store";
import { z } from "zod";
import { gepaHash, parseGepaPlannerCase } from "./gepa-planner-case.ts";
import { proveGepaSources } from "./gepa-source-proof.ts";
import { GepaWireRecorder } from "./gepa-wire-recorder.ts";

const requestSchema: z.ZodType<JSONSchema> = z.lazy(() =>
  z
    .object({
      type: z.union([z.string(), z.array(z.string())]).optional(),
      properties: z.record(z.string(), requestSchema).optional(),
      items: z.union([requestSchema, z.array(requestSchema)]).optional(),
      required: z.array(z.string()).optional(),
    })
    .catchall(z.json()),
);

async function main() {
  const stateRoot = resolveAliasedEnvValue("ELIZA_STATE_DIR");
  if (!stateRoot || stateRoot !== process.cwd())
    throw new Error("Worker must own its state directory");
  if (
    Object.keys(process.env).some((key) =>
      /(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key),
    )
  )
    throw new Error("Read-only worker refuses inherited provider credentials");
  const input = parseGepaPlannerCase(JSON.parse(await Bun.stdin.text()));
  const sourceProof = await proveGepaSources(input.target.runtimeRevision);
  const revision = sourceProof.revision;
  // Load the runtime only after resolving and qualifying its source checkout.
  const { ModelType, resolveOptimizedPromptForRuntime } = await import(
    "@elizaos/core"
  );
  const { plannerTemplate } = await import(
    "../../../../plugins/plugin-assistant/src/prompts/planner.ts"
  );
  const { runPlannerLoop } = await import(
    "../../../../plugins/plugin-assistant/src/runtime/planner-loop.ts"
  );
  const { createTestRuntime } = await import("../../src/pglite-runtime.ts");
  if (input.candidate.baseline !== plannerTemplate)
    throw new Error("Candidate baseline differs from the current planner");
  const originalHash = gepaHash(input);
  const recorder = new GepaWireRecorder(fetch);
  const harness = await createTestRuntime({
    characterName: "Isolated GEPA planner",
    pgliteDir: join(stateRoot, "pglite"),
    embeddingDimensions: 384,
  });
  const { runtime } = harness;
  try {
    const calls: Array<{
      provider: string;
      model: string;
      modelType: string;
      latencyMs: number;
      inputTokens: number | null;
      outputTokens: number | null;
      cachedTokens: number | null;
      usage: unknown;
    }> = [];
    runtime.registerModel(
      ModelType.TEXT_LARGE,
      async (_runtime, params) => {
        const body = JSON.stringify({
          model: input.target.model,
          ...input.generation,
          request: params,
        });
        if (Buffer.byteLength(body) > input.maxRequestBytes)
          throw new Error(
            "Complete model request exceeds the declared fixture limit",
          );
        const started = performance.now();
        const response = await recorder.fetch(input.target.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        if (!response.ok)
          throw new Error(`Model fixture HTTP ${response.status}`);
        const result: unknown = await response.json();
        if (
          !result ||
          typeof result !== "object" ||
          !("text" in result) ||
          typeof result.text !== "string"
        )
          throw new Error("Model fixture omitted complete text response");
        const usage =
          "usage" in result && result.usage != null
            ? z.record(z.string(), z.json()).parse(result.usage)
            : null;
        const metric = (name: string) =>
          usage?.[name] == null
            ? null
            : z.number().int().nonnegative().parse(usage[name]);
        calls.push({
          provider: input.target.provider,
          model: input.target.model,
          modelType: ModelType.TEXT_LARGE,
          latencyMs: performance.now() - started,
          inputTokens: metric("promptTokens"),
          outputTokens: metric("completionTokens"),
          cachedTokens: metric("cachedTokens"),
          usage,
        });
        return result;
      },
      input.target.provider,
    );
    const candidateResolver = {
      getPrompt(task: string, baseline?: string) {
        if (task !== "action_planner" || baseline !== input.candidate.baseline)
          throw new Error("Candidate instruction scope changed");
        return {
          prompt: input.candidate.prompt,
          fewShotExamples: input.candidate.fewShotExamples,
        };
      },
    };
    const adapter: PlannerRuntime = {
      useModel: (type, params, provider) => {
        const { responseSchema, providerOptions, ...request } = params;

        return runtime.useModel(
          type,
          {
            ...request,
            ...(responseSchema === undefined
              ? {}
              : { responseSchema: requestSchema.parse(responseSchema) }),
            ...(providerOptions === undefined
              ? {}
              : {
                  providerOptions: z
                    .record(z.string(), z.json())
                    .parse(providerOptions),
                }),
          },
          provider,
        );
      },
      getService: (name) =>
        name === "optimized_prompt" ? candidateResolver : undefined,
    };
    const resolvedInstruction = resolveOptimizedPromptForRuntime(
      adapter,
      "action_planner",
      plannerTemplate,
    );
    // The canonical baseline includes a legacy context placeholder. The actual
    // planner emits its instruction prefix and the complete dynamic message
    // separately. Custom candidates must still survive byte-for-byte.
    const expectedInstruction =
      resolvedInstruction === plannerTemplate
        ? plannerTemplate.split("context_object:")[0].trim()
        : resolvedInstruction;
    const dynamicText = JSON.stringify(input.dynamic);
    let attemptedEffect = false;
    const result = await runPlannerLoop({
      runtime: adapter,
      provider: input.target.provider,
      context: {
        id: input.caseId,
        events: [
          {
            id: "complete-evaluation-input",
            type: "message",
            message: { role: "user", content: dynamicText },
          },
        ],
      },
      executeToolCall: () => {
        attemptedEffect = true;
        throw new Error(
          "Read-only GEPA worker does not admit effect execution",
        );
      },
    });
    if (attemptedEffect)
      throw new Error(
        "Effect attempt invalidates a read-only planner evaluation",
      );
    const wire = await recorder.close();
    if (
      !wire.length ||
      wire.length !== calls.length ||
      wire.some((call) => !call.response || call.transportFailed)
    )
      throw new Error("Incomplete model evidence invalidates the evaluation");
    for (const call of wire) {
      const request = JSON.parse(
        Buffer.from(call.requestBase64, "base64").toString("utf8"),
      );
      const messages = request.request.messages;
      if (
        !Array.isArray(messages) ||
        !messages.some(
          (message) =>
            typeof message.content === "string" &&
            message.content.includes(dynamicText),
        ) ||
        !messages.some(
          (message) =>
            typeof message.content === "string" &&
            message.content.includes(expectedInstruction),
        )
      )
        throw new Error(
          "Actual model request omitted complete dynamic inputs or candidate instruction",
        );
    }
    if (gepaHash(input) !== originalHash)
      throw new Error("Evaluation mutated its immutable input");
    const finalSourceProof = await proveGepaSources(revision);
    if (gepaHash(sourceProof) !== gepaHash(finalSourceProof))
      throw new Error("Runtime source proof changed during evaluation");
    await writeFile(
      join(stateRoot, "evidence.json"),
      JSON.stringify({
        schemaVersion: 1,
        qualification: "deterministic-planner-boundary-only",
        activated: false,
        inheritedProviderCredentials: false,
        processId: process.pid,
        stateRoot,
        caseSha256: originalHash,
        input,
        candidateSha256: gepaHash(input.candidate),
        renderedInstructionSha256: gepaHash(expectedInstruction),
        runtimeRevision: revision,
        sourceProof,
        workerSourceSha256: createHash("sha256")
          .update(await readFile(new URL(import.meta.url)))
          .digest("hex"),
        result,
        calls,
        wire,
      }),
      { flag: "wx", mode: 0o600 },
    );
  } finally {
    await harness.cleanup();
  }
}
if (import.meta.main) await main();
