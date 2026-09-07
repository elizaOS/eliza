/**
 * Exercises caller response schemas through the production text handler and real
 * AI SDK against a loopback HTTP provider. Streaming and complete responses retain
 * optional fields, JSON-only compatibility, complete prompts and provider errors.
 */
import { createServer } from "node:http";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../../../packages/core/src/database/inMemoryAdapter";
import { AgentRuntime } from "../../../packages/core/src/runtime";
import { handleTextSmall } from "../models/text";

afterEach(() => vi.restoreAllMocks());

type WireRequest = {
  model: string;
  stream?: boolean;
  messages: Array<{ role: string; content: string }>;
  response_format?: {
    type: string;
    json_schema?: { strict?: boolean; schema: object };
  };
};

it.each([false, true])(
  "preserves Cerebras response schemas on the SDK wire (stream=%s)",
  async (stream) => {
    const bodies: WireRequest[] = [];
    let rejectSchema = false;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body: WireRequest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        bodies.push(body);
        if (rejectSchema) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: {
                message: "Unsupported response_format json_schema: open object schema",
                type: "invalid_request_error",
                code: "invalid_json_schema",
              },
            })
          );
          return;
        }
        const content = JSON.stringify({ answer: "ok" });
        const completion = {
          id: "response-schema-wire",
          object: body.stream ? "chat.completion.chunk" : "chat.completion",
          created: 1,
          model: body.model,
          choices: [
            {
              index: 0,
              ...(body.stream
                ? { delta: { role: "assistant", content } }
                : { message: { role: "assistant", content } }),
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
        };
        if (body.stream) {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(`data: ${JSON.stringify(completion)}\n\ndata: [DONE]\n\n`);
        } else {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(completion));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let runtimeOwner: AgentRuntime | undefined;
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing loopback port");
      const originalFetch = globalThis.fetch;
      vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        );
        if (url.hostname !== "127.0.0.1" || url.port !== String(address.port)) {
          throw new Error("Test forbids non-loopback provider calls");
        }
        return originalFetch(input, init);
      });
      const runtime = new AgentRuntime({
        character: {
          name: "ResponseSchemaWire",
          bio: "test",
          settings: {
            ELIZA_PROVIDER: "cerebras",
            OPENAI_API_KEY: "test-loopback-key",
            OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
            CEREBRAS_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
            CEREBRAS_API_KEY: "test-loopback-key",
            CEREBRAS_SMALL_MODEL: "qwen-3.8-27b",
            OPENAI_SMALL_MODEL: "qwen-3.8-27b",
          },
        },
        adapter: new InMemoryDatabaseAdapter(),
        logLevel: "fatal",
      });
      runtimeOwner = runtime;
      const responseSchema = {
        type: "object",
        properties: {
          answer: { type: "string" },
          optionalExplanation: { type: "string" },
        },
        required: ["answer"],
        additionalProperties: false,
      };
      for (const variant of ["schema", "schema-with-json-mode", "json-mode"] as const) {
        const prompt = "Return JSON with the answer. Preserve this request's complete content 🧭.";
        const before = bodies.length;
        const result = await handleTextSmall(runtime, {
          prompt,
          stream,
          ...(variant !== "json-mode" ? { responseSchema } : {}),
          ...(variant !== "schema" ? { responseFormat: { type: "json_object" } } : {}),
        });
        let text: string;
        if (typeof result === "string") text = result;
        else if (!stream) text = await result.text;
        else {
          let streamed = "";
          for await (const chunk of result.textStream) streamed += chunk;
          text = await result.text;
          expect(streamed).toBe(text);
        }
        expect(JSON.parse(text)).toEqual({ answer: "ok" });
        expect(bodies).toHaveLength(before + 1);
        const wire = bodies.at(-1);
        expect(wire?.messages.find((message) => message.role === "user")?.content).toBe(prompt);
        if (variant === "json-mode") expect(wire?.response_format).toEqual({ type: "json_object" });
        else {
          expect(wire?.response_format?.type).toBe("json_schema");
          expect(wire?.response_format?.json_schema?.strict).toBe(true);
          expect(wire?.response_format?.json_schema?.schema).toEqual(responseSchema);
        }
      }
      // A rejected caller schema must not silently retry with a weaker contract.
      rejectSchema = true;
      const beforeRejection = bodies.length;
      const unsupportedSchema = { type: "object", additionalProperties: true };
      await expect(
        (async () => {
          const result = await handleTextSmall(runtime, {
            prompt: "Return JSON for this unsupported schema.",
            responseSchema: unsupportedSchema,
            stream,
          });
          if (typeof result !== "string") {
            for await (const chunk of result.textStream) void chunk;
            await result.text;
          }
        })()
      ).rejects.toThrow(/Unsupported response_format/);
      expect(bodies).toHaveLength(beforeRejection + 1);
      expect(bodies.at(-1)?.response_format?.json_schema?.schema).toEqual(unsupportedSchema);
    } finally {
      // Teardown failures are reported separately so the original assertion survives.
      onTestFinished(async () => {
        const cleanup = await Promise.allSettled([
          Promise.resolve().then(() => runtimeOwner?.stop()),
          Promise.resolve().then(async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve()))
            );
          }),
        ]);
        const failures = cleanup.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : []
        );
        if (failures.length > 0)
          throw new AggregateError(failures, "Response schema wire test teardown failed");
      });
    }
  }
);
