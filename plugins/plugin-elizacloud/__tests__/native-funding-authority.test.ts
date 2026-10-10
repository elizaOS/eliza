/** Exercises the actual Cloud handler, SDK HTTP and AgentRuntime fallback against a controlled local provider failure. */

import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ContextObject,
  type EvaluatorRuntime,
  EventType,
  ModelType,
  modelOutputIncompleteEvidence,
  runWithTrajectoryContext,
  type TrajectoryRuntimeLlmCallParams,
} from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { expect, test, vi } from "vitest";
import { runEvaluator } from "../../plugin-assistant/src/runtime/evaluator";
import { createJsonFileTrajectoryRecorder } from "../../plugin-assistant/src/runtime/trajectory-recorder";
import { handleTextLarge } from "../src/models/text";
import { handleCloudStatusRoutes } from "../src/routes/cloud-status-routes";
import { handleCloudStatusRoutes as handleAutonomousCloudStatusRoutes } from "../src/routes/cloud-status-routes-autonomous";

test("canonical evaluator history reaches the Cloud HTTP wire as linked OpenAI calls", async () => {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [{ message: { content: "fixture completed" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 },
      })
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Expected local HTTP listener");
  const runtime = createSQLiteTestRuntime({
    character: { name: "Canonical history fixture", bio: ["tests"] },
    settings: {
      ELIZAOS_CLOUD_API_KEY: "eliza_controlled_native",
      ELIZAOS_CLOUD_BASE_URL: `http://127.0.0.1:${address.port}/api/v1`,
      ELIZAOS_CLOUD_APPLICATION_SLOT: "fixture-product",
    },
    logLevel: "fatal",
  });
  const input = { nested: { text: 'exact "quoted"\ntext', count: 0 } };
  const result = { status: "pending", approved: false, text: "exact\nreceipt" };
  const messages = [
    { role: "user", content: "Review evidence only" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Before" },
        { type: "tool-call", toolCallId: "call_first", toolName: "PROPOSE_DEVICE_ACTION", input },
        { type: "text", text: "After" },
        {
          type: "tool-call",
          toolCallId: "call_second",
          toolName: "READ_CONTEXT",
          input: { reference: "fixture" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_first",
          toolName: "PROPOSE_DEVICE_ACTION",
          output: { type: "json", value: result },
        },
        {
          type: "tool-result",
          toolCallId: "call_second",
          toolName: "READ_CONTEXT",
          output: { type: "text", value: "exact second\nresult" },
        },
      ],
    },
    { role: "user", content: "Evaluate; do not execute anything" },
  ];
  const original = structuredClone(messages);
  try {
    runtime.registerModel(ModelType.TEXT_LARGE, handleTextLarge, "application-provider", 100);
    await runtime.initialize();
    const invokeModel = runtime.useModel.bind(runtime);
    await invokeModel(ModelType.TEXT_LARGE, { messages: messages as never });
    expect(messages).toEqual(original);
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toHaveProperty("tools");
    expect(requests[0]).not.toHaveProperty("tool_choice");
    const wire = requests[0].messages as Array<Record<string, unknown>>;
    const assistant = wire.find((message) => message.role === "assistant");
    expect(assistant?.content).toEqual([
      { type: "text", text: "Before" },
      { type: "text", text: "After" },
    ]);
    expect(assistant?.tool_calls).toEqual([
      {
        id: "call_first",
        type: "function",
        function: { name: "PROPOSE_DEVICE_ACTION", arguments: JSON.stringify(input) },
      },
      {
        id: "call_second",
        type: "function",
        function: { name: "READ_CONTEXT", arguments: JSON.stringify({ reference: "fixture" }) },
      },
    ]);
    expect(wire.filter((message) => message.role === "tool")).toEqual([
      { role: "tool", tool_call_id: "call_first", content: JSON.stringify(result) },
      { role: "tool", tool_call_id: "call_second", content: "exact second\nresult" },
    ]);
    // Already linked OpenAI history keeps its original wire representation.
    const linked = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "linked", type: "function", function: { name: "fixture", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "linked", content: "unchanged" },
    ];
    await invokeModel(ModelType.TEXT_LARGE, { messages: structuredClone(linked) as never });
    expect(
      (requests[1].messages as typeof linked).filter((message) => message.role !== "system")
    ).toEqual(linked);
    const outputs = [
      { type: "json", value: null },
      { type: "json", value: "quoted JSON scalar" },
      { type: "error-text", value: "No record was shared" },
      { type: "error-json", value: { failed: true, reason: "unavailable" } },
      { type: "execution-denied", reason: "Owner declined" },
      { type: "execution-denied" },
      { type: "content", value: [{ type: "text", text: "complete content" }] },
    ];
    await invokeModel(ModelType.TEXT_LARGE, {
      messages: [
        {
          role: "assistant",
          content: outputs.map((_, index) => ({
            type: "tool-call",
            toolCallId: `output_${index}`,
            toolName: "fixture",
            input: null,
          })),
        },
        {
          role: "tool",
          content: outputs.map((output, index) => ({
            type: "tool-result",
            toolCallId: `output_${index}`,
            toolName: "fixture",
            output,
          })),
        },
      ] as never,
    });
    const outputWire = requests[2].messages as Array<Record<string, unknown>>;
    expect(
      outputWire.filter((message) => message.role === "tool").map((message) => message.content)
    ).toEqual([
      "null",
      '"quoted JSON scalar"',
      "No record was shared",
      JSON.stringify({ failed: true, reason: "unavailable" }),
      "Owner declined",
      "Tool execution denied.",
      JSON.stringify([{ type: "text", text: "complete content" }]),
    ]);
    expect(outputWire.find((message) => message.role === "assistant")).toMatchObject({
      tool_calls: outputs.map(() => ({ function: { arguments: "null" } })),
    });
    // Unpaired canonical calls/results retain the existing orphan policy.
    await invokeModel(ModelType.TEXT_LARGE, {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "unanswered", toolName: "fixture", input: {} },
          ],
        },
        { role: "user", content: "Interrupted" },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "orphan",
              toolName: "fixture",
              output: { type: "json", value: result },
            },
          ],
        },
      ] as never,
    });
    const orphanWire = requests[3].messages as Array<Record<string, unknown>>;
    expect(orphanWire.find((message) => message.role === "assistant")).not.toHaveProperty(
      "tool_calls"
    );
    expect(orphanWire.some((message) => message.role === "tool")).toBe(false);
    expect(orphanWire.at(-1)).toMatchObject({
      role: "user",
      content: `[tool result] ${JSON.stringify(result)}`,
    });
    expect(requests).toHaveLength(4);
  } finally {
    await runtime.stop();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

test.each([
  { name: "provider failure", admission: false, recover: false, attempts: 1 },
  { name: "recovered admission", admission: true, recover: true, attempts: 2 },
  { name: "exhausted admission", admission: true, recover: false, attempts: 5 },
])(
  "native product $name retains funding authority instead of using another payer",
  async ({ admission, recover, attempts }) => {
    const requests: Array<{
      slot: string | string[] | undefined;
      operation: string | string[] | undefined;
    }> = [];
    const server = createServer((request, response) => {
      requests.push({
        slot: request.headers["x-eliza-application-slot"],
        operation: request.headers["idempotency-key"],
      });
      request.resume();
      if (recover && requests.length > 1) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            choices: [{ message: { content: "admitted response" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        );
      } else {
        response.writeHead(503, {
          "Content-Type": "application/json",
          ...(admission ? { "Retry-After": "1" } : {}),
        });
        response.end(
          JSON.stringify({
            error: admission
              ? {
                  message: "Inference admission is temporarily unavailable. Retry shortly.",
                  type: "service_unavailable",
                  code: "inference_admission_unavailable",
                }
              : { message: "upstream provider failed", type: "api_error", code: "provider_failed" },
          })
        );
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected local HTTP listener");
    try {
      const runtime = createSQLiteTestRuntime({
        character: { name: "Funded fixture", bio: ["tests"] },
        settings: {
          ELIZAOS_CLOUD_API_KEY: "eliza_controlled_native",
          ELIZAOS_CLOUD_BASE_URL: `http://127.0.0.1:${address.port}/api/v1`,
          ELIZAOS_CLOUD_APPLICATION_SLOT: "fixture-product",
        },
        logLevel: "fatal",
      });
      const personalProvider = vi.fn(async () => "personal-funded response");
      runtime.registerModel(ModelType.TEXT_LARGE, handleTextLarge, "application-provider", 100);
      runtime.registerModel(ModelType.TEXT_LARGE, personalProvider, "personal-provider", 10);
      const invokeModel = runtime.useModel.bind(runtime);
      const result = invokeModel(ModelType.TEXT_LARGE, { prompt: "Complete original request" });
      if (recover) {
        await expect(result).resolves.toBe("admitted response");
      } else {
        await expect(result).rejects.toMatchObject({ code: "MODEL_FUNDING_AUTHORITY_FAILED" });
      }
      expect(personalProvider).not.toHaveBeenCalled();
      expect(requests).toHaveLength(attempts);
      expect(requests[0]?.slot).toBe("fixture-product");
      expect(requests[0]?.operation).toEqual(expect.any(String));
      expect(requests.every((request) => request.slot === requests[0]?.slot)).toBe(true);
      expect(requests.every((request) => request.operation === requests[0]?.operation)).toBe(true);
      for (const handler of [handleCloudStatusRoutes, handleAutonomousCloudStatusRoutes]) {
        const json = vi.fn();
        await handler({
          req: {} as never,
          res: {} as never,
          method: "GET",
          pathname: "/api/cloud/status",
          config: {},
          runtime,
          json,
        });
        expect(json).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            applicationBilling: { kind: "configured", slotKey: requests[0]?.slot },
          })
        );
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  },
  10_000
);

test.each([
  { maxTokens: undefined, emptyVisibleOutput: false },
  { maxTokens: 7, emptyVisibleOutput: false },
  { maxTokens: undefined, emptyVisibleOutput: true },
])(
  "buffered Cloud incomplete output retains evidence with cap $maxTokens and empty visible output $emptyVisibleOutput",
  async ({ maxTokens, emptyVisibleOutput }) => {
    const requests: Record<string, unknown>[] = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push(JSON.parse(body));
      response.writeHead(200, { "Content-Type": "application/json" });
      // A gateway may synthesize length for an empty visible response. This is
      // wire evidence, not proof of an underlying provider cap or finish reason.
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: emptyVisibleOutput ? "" : "MUST_NOT_REACH_ERROR_OR_TRAJECTORY",
              },
              finish_reason: "length",
            },
          ],
          usage: {
            prompt_tokens: 11,
            completion_tokens: 19,
            total_tokens: 30,
            prompt_tokens_details: { cached_tokens: 3 },
            cost_usd: 0.125,
          },
          private_completion: "MUST_NOT_REACH_ERROR_OR_TRAJECTORY",
        })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Expected local HTTP listener");
    const directory = await mkdtemp(join(tmpdir(), "cloud-incomplete-"));
    let cleanupRuntime: ReturnType<typeof createSQLiteTestRuntime> | undefined;
    try {
      const runtime = createSQLiteTestRuntime({
        character: { name: "Incomplete fixture", bio: ["tests"] },
        settings: {
          ELIZAOS_CLOUD_API_KEY: "eliza_controlled_native",
          ELIZAOS_CLOUD_BASE_URL: `http://127.0.0.1:${address.port}/api/v1`,
          ELIZAOS_CLOUD_APPLICATION_SLOT: "fixture-product",
        },
        logLevel: "fatal",
      });
      cleanupRuntime = runtime;
      runtime.registerModel(
        ModelType.TEXT_LARGE,
        (rt, params) =>
          handleTextLarge(rt, { ...params, ...(maxTokens === undefined ? {} : { maxTokens }) }),
        "application-provider",
        100
      );
      const personalProvider = vi.fn(async () => "must not replay");
      runtime.registerModel(ModelType.TEXT_LARGE, personalProvider, "personal-provider", 10);
      await runtime.initialize();
      const events = vi.spyOn(runtime, "emitEvent").mockResolvedValue(undefined);
      const llmCalls: TrajectoryRuntimeLlmCallParams[] = [];
      const host = runtime as unknown as { _ensureServiceStarted(type: string): Promise<unknown> };
      const ensureService = host._ensureServiceStarted.bind(runtime);
      vi.spyOn(host, "_ensureServiceStarted").mockImplementation(async (type) =>
        type === "trajectories"
          ? { logLlmCall: (call: TrajectoryRuntimeLlmCallParams) => llmCalls.push(call) }
          : ensureService(type)
      );
      const recorder = createJsonFileTrajectoryRecorder({ rootDir: directory, enabled: true });
      const trajectoryId = recorder.startTrajectory({
        agentId: runtime.agentId,
        rootMessage: { id: "incomplete-message", text: "Review actual evidence" },
      });
      const context: ContextObject = { id: "incomplete-context", events: [] };
      const onUsage = vi.fn();
      let failure: unknown;
      try {
        await runWithTrajectoryContext(
          { trajectoryStepId: "incomplete-step", purpose: "evaluator" },
          () =>
            runEvaluator({
              runtime: runtime as unknown as EvaluatorRuntime,
              context,
              trajectory: {
                context,
                steps: [],
                archivedSteps: [],
                plannedQueue: [],
                evaluatorOutputs: [],
              },
              recorder,
              trajectoryId,
              onUsage,
            })
        );
      } catch (error) {
        failure = error;
      }
      const evidence = modelOutputIncompleteEvidence(failure);
      expect(evidence).toMatchObject({
        provider: "elizacloud",
        model: requests[0]?.model,
        finishReason: "length",
        finishReasonSource: "cloud-chat-completions",
        emptyVisibleOutput,
        maxTokens: maxTokens ?? null,
        usage: { promptTokens: 11, completionTokens: 19, totalTokens: 30, cacheReadInputTokens: 3 },
        costUsd: 0.125,
      });
      expect(requests).toHaveLength(1);
      expect(Object.hasOwn(requests[0], "max_tokens")).toBe(maxTokens !== undefined);
      expect(personalProvider).not.toHaveBeenCalled();
      expect(onUsage).toHaveBeenCalledExactlyOnceWith({ promptTokens: 11, completionTokens: 19 });
      expect(events.mock.calls.filter(([type]) => type === EventType.MODEL_USED)).toHaveLength(1);
      await vi.waitFor(() => expect(llmCalls).toHaveLength(1));
      expect(llmCalls[0]).toMatchObject({
        model: requests[0]?.model,
        finishReason: "length",
        promptTokens: 11,
        completionTokens: 19,
        providerMetadata: evidence,
        ...(maxTokens === undefined ? { maxTokensOmitted: true } : { maxTokens }),
      });
      const trajectory = await recorder.load(trajectoryId);
      expect(trajectory?.stages).toHaveLength(1);
      expect(trajectory?.stages[0]).toMatchObject({
        evaluation: { success: false, protocolFailure: true },
        model: {
          modelName: requests[0]?.model,
          finishReason: "length",
          usage: evidence?.usage,
          costUsd: 0.125,
          providerOptions: { outputEvidence: evidence },
        },
      });
      expect(trajectory?.metrics).toMatchObject({
        totalPromptTokens: 11,
        totalCompletionTokens: 19,
        totalCostUsd: 0.125,
      });
      expect(JSON.stringify({ failure, evidence, llmCalls, trajectory })).not.toContain(
        "MUST_NOT_REACH_ERROR_OR_TRAJECTORY"
      );
      expect(JSON.stringify((failure as { context?: unknown })?.context)).not.toContain(
        "eliza_controlled_native"
      );
    } finally {
      await cleanupRuntime?.stop();
      await rm(directory, { recursive: true, force: true });
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  }
);
