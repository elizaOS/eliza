/**
 * Runs the actual Google SDK, provider handler, AgentRuntime and evaluator against
 * a deterministic loopback Gemini endpoint. A persisted processor readback proves
 * complete STOP results reach effects; incomplete/tool/invalid results cannot.
 * No Google account, live model, or evaluator/model-handler mock is used.
 */
import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../../../packages/core/src/database/inMemoryAdapter";
import { AgentRuntime } from "../../../packages/core/src/runtime";
import { EvaluatorService } from "../../../packages/core/src/services/evaluator";
import {
  type Evaluator,
  type Memory,
  ModelType,
} from "../../../packages/core/src/types";
import { handleTextSmall } from "../models/text";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([
  { finishReason: "STOP", tool: false, malformed: false, succeeds: true },
  {
    finishReason: "MAX_TOKENS",
    tool: false,
    malformed: false,
    succeeds: false,
  },
  { finishReason: "SAFETY", tool: false, malformed: false, succeeds: false },
  { finishReason: "STOP", tool: true, malformed: false, succeeds: false },
  { finishReason: "STOP", tool: false, malformed: true, succeeds: false },
  { finishReason: undefined, tool: false, malformed: false, succeeds: false },
])(
  "Google evaluator effect requires complete JSON ($finishReason, tool=$tool, malformed=$malformed)",
  async ({ finishReason, tool, malformed, succeeds }) => {
    const requests: Array<{
      contents: Array<{ parts: Array<{ text?: string }> }>;
      generationConfig?: { responseJsonSchema?: object };
    }> = [];
    const payload = "Complete extracted fact: reference FINAL-GOOGLE-731";
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [
                    {
                      text: malformed
                        ? "{broken-json"
                        : JSON.stringify({ store: { text: payload } }),
                    },
                    ...(tool
                      ? [
                          {
                            functionCall: {
                              name: "write",
                              args: { text: payload },
                            },
                          },
                        ]
                      : []),
                  ],
                },
                ...(finishReason ? { finishReason } : {}),
              },
            ],
            usageMetadata: {
              promptTokenCount: 100,
              candidatesTokenCount: 20,
              totalTokenCount: 120,
            },
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    let runtime: AgentRuntime | undefined;
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No loopback address");
      const originalFetch = globalThis.fetch;
      vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const url = new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        );
        if (url.hostname !== "127.0.0.1" || url.port !== String(address.port)) {
          throw new Error("Test forbids non-loopback Google calls");
        }
        return originalFetch(input, init);
      });
      vi.stubEnv("GOOGLE_GEMINI_BASE_URL", `http://127.0.0.1:${address.port}`);
      vi.stubEnv("GOOGLE_GENAI_USE_VERTEXAI", "false");
      runtime = new AgentRuntime({
        character: {
          name: "GoogleEvaluatorWire",
          bio: "test",
          settings: {
            secrets: { GOOGLE_GENERATIVE_AI_API_KEY: "loopback-test-key" },
          },
        },
        adapter: new InMemoryDatabaseAdapter(),
        disableBasicCapabilities: true,
        enableAutonomy: false,
        logLevel: "fatal",
      });
      runtime.registerModel(
        ModelType.TEXT_SMALL,
        handleTextSmall,
        "google-genai",
        100,
      );
      const owner = runtime;
      const saved: string[] = [];
      const evaluator: Evaluator<{ text: string }> = {
        name: "store",
        description: "Persist an extracted fact",
        schema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        shouldRun: async () => true,
        prompt: () => "Extract the complete latest fact into store.text.",
        parse: (value) => {
          if (
            typeof value !== "object" ||
            value === null ||
            !("text" in value) ||
            typeof value.text !== "string"
          )
            return null;
          return { text: value.text };
        },
        processors: [
          {
            process: async ({ message, output }) => {
              saved.push(
                await owner.createMemory(
                  {
                    ...message,
                    id: crypto.randomUUID() as Memory["id"],
                    content: { text: output.text },
                  },
                  "messages",
                ),
              );
              return { success: true };
            },
          },
        ],
      };
      runtime.registerEvaluator(evaluator);
      const message: Memory = {
        id: crypto.randomUUID() as Memory["id"],
        entityId: crypto.randomUUID() as Memory["entityId"],
        roomId: crypto.randomUUID() as Memory["roomId"],
        content: { text: payload },
      };
      const result = await new EvaluatorService(runtime).run(message, {
        values: {},
        data: {},
        text: "",
      });
      expect(requests.length).toBeGreaterThan(0);
      expect(
        requests[0].contents
          .flatMap((content) => content.parts.map((part) => part.text ?? ""))
          .join("\n"),
      ).toContain(payload);
      expect(requests[0].generationConfig?.responseJsonSchema).toBeDefined();
      if (succeeds) {
        expect(result.errors).toEqual([]);
        expect(result.processedEvaluators).toEqual(["store"]);
        const id = saved[0];
        if (!id) throw new Error("Missing persisted effect");
        expect(
          (await runtime.getMemoryById(id as NonNullable<Memory["id"]>))
            ?.content.text,
        ).toBe(payload);
      } else {
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.processedEvaluators).toEqual([]);
        expect(saved).toEqual([]);
      }
    } finally {
      await runtime?.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
  30_000,
);
