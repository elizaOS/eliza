/**
 * Wire-boundary regression for #18025 on the Anthropic path: request bodies
 * built by the text handler must serialize to well-formed strict JSON even
 * when upstream text carries lone UTF-16 surrogates (a mid-emoji `.slice()`
 * leaves a lone leading surrogate that `JSON.stringify` emits as a bare
 * `\uD8xx` escape strict provider parsers reject). Real `@ai-sdk/anthropic`
 * client against a loopback Messages API server capturing raw request bytes.
 */
import { createServer, type Server } from "node:http";
import { type ElizaError, type IAgentRuntime, MAX_WELL_FORMED_VISITS } from "@elizaos/core";
import { jsonSchema } from "ai";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleTextSmall } from "../models";

/** JSON.stringify only escapes surrogate code units when they are lone; a
 * well-formed body therefore contains no \ud800-\udfff escape at all. */
const LONE_SURROGATE_ESCAPE = /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/;

const captured: Buffer[] = [];
let server: Server;
let baseUrl: string;

function startCaptureServer(): Promise<string> {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      captured.push(Buffer.from(raw, "utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      // When the request includes a structured output schema, the Anthropic
      // native output parser parses the response as JSON; return valid JSON.
      const hasStructuredOutput = /response_format|responseSchema|"schema"/.test(raw);
      const text = hasStructuredOutput ? JSON.stringify({ goodField: "value" }) : "ok";
      // A prompt containing "force tool use" gets a tool_use reply naming the
      // first tool from the request, so the SDK parses tool input through the
      // tool's inputSchema.validate (#24698 r3 F3 behavioral pin).
      const content: unknown[] = [{ type: "text", text }];
      if (raw.includes("force tool use")) {
        let toolName = "unknown_tool";
        try {
          const parsed = JSON.parse(raw) as { tools?: Array<{ name?: string }> };
          toolName = parsed.tools?.[0]?.name ?? toolName;
        } catch {
          // keep the fallback name; malformed bodies still need a reply
        }
        content.unshift({
          type: "tool_use",
          id: "toolu_probe",
          name: toolName,
          input: { anything: true },
        });
      }
      response.end(
        JSON.stringify({
          id: "msg-test",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content,
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      );
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("capture server did not bind a TCP port"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}/v1`);
    });
  });
}

function buildRuntime(): IAgentRuntime {
  const settings: Record<string, string> = {
    ANTHROPIC_API_KEY: "test-key",
    ANTHROPIC_AUTH_MODE: "apikey",
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_SMALL_MODEL: "claude-test",
  };
  return {
    getSetting: vi.fn((key: string) => settings[key]),
    character: { name: "Ada" },
    emitEvent: vi.fn(),
    getService: vi.fn(() => null),
    getServicesByType: vi.fn(() => []),
  } as unknown as IAgentRuntime;
}

beforeAll(async () => {
  baseUrl = await startCaptureServer();
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  captured.length = 0;
  vi.stubEnv("ANTHROPIC_AUTH_MODE", "apikey");
  vi.stubEnv("ELIZA_TRAJECTORY_STRICT", undefined);
});

describe("#18025: Anthropic request bodies are well-formed strict JSON", () => {
  it("rejects an oversized sparse response schema before opening a provider request", async () => {
    const sparseSchema = new Array(MAX_WELL_FORMED_VISITS);

    await expect(
      handleTextSmall(buildRuntime(), {
        prompt: "hello",
        responseSchema: sparseSchema,
      } as never)
    ).rejects.toMatchObject({
      code: "WELL_FORMED_UNBOUNDED",
      context: { reason: "visits" },
    } satisfies Partial<ElizaError>);
    expect(captured).toHaveLength(0);
  });

  it("sanitizes a prompt truncated mid-emoji (lone leading surrogate)", async () => {
    const brokenPrompt = "summarize this page 🤖 please".slice(0, 21); // splits 🤖
    expect(LONE_SURROGATE_ESCAPE.test(JSON.stringify(brokenPrompt))).toBe(true);

    const result = await handleTextSmall(buildRuntime(), { prompt: brokenPrompt } as never);
    expect(result).toBe("ok");

    expect(captured).toHaveLength(1);
    const body = new TextDecoder("utf-8", { fatal: true }).decode(captured[0]);
    expect((body as unknown as { isWellFormed: () => boolean }).isWellFormed()).toBe(true);
    expect(LONE_SURROGATE_ESCAPE.test(body)).toBe(false);
    const parsed = JSON.parse(body) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(JSON.stringify(parsed.messages)).toContain("summarize this page �");
  });

  // #18081: Tool descriptions, stop sequences, output schemas, and provider
  // options must also be sanitized — the original #18079 only sanitized
  // prompt/messages/system, leaving these fields raw.
  it("sanitizes a lone surrogate in a stop sequence (#18081)", async () => {
    const result = await handleTextSmall(buildRuntime(), {
      prompt: "hello",
      stopSequences: ["clean-stop", "bad\uD83D"],
    } as never);
    expect(result).toBe("ok");

    expect(captured).toHaveLength(1);
    const raw = captured[0].toString("utf8");
    expect(LONE_SURROGATE_ESCAPE.test(raw)).toBe(false);
    const body = new TextDecoder("utf-8", { fatal: true }).decode(captured[0]);
    expect((body as unknown as { isWellFormed: () => boolean }).isWellFormed()).toBe(true);
    const parsed = JSON.parse(body) as { stop_sequences?: string[] };
    expect(parsed.stop_sequences).toContain("clean-stop");
    // The lone surrogate in the stop sequence was replaced with U+FFFD.
    expect(parsed.stop_sequences).toContain("bad�");
  });

  it("sanitizes a lone surrogate in a tool description (#18081)", async () => {
    const result = await handleTextSmall(buildRuntime(), {
      prompt: "use the tool",
      tools: {
        lone_surrogate_tool: {
          name: "lone_surrogate_tool",
          description: `bad tool \uD83D`,
          parameters: { type: "object", properties: {} },
        },
      },
    } as never);
    expect(typeof result === "string" ? result : (result as { text: string }).text).toBe("ok");

    expect(captured).toHaveLength(1);
    const raw = captured[0].toString("utf8");
    expect(LONE_SURROGATE_ESCAPE.test(raw)).toBe(false);
    const body = new TextDecoder("utf-8", { fatal: true }).decode(captured[0]);
    expect((body as unknown as { isWellFormed: () => boolean }).isWellFormed()).toBe(true);
    const serialized = JSON.stringify(JSON.parse(body));
    expect(serialized).toContain("bad tool \uFFFD");
    expect(LONE_SURROGATE_ESCAPE.test(serialized)).toBe(false);
  });

  // #18081 review: structured-output schemas must also be sanitized. The plain
  // schema is sanitized before being wrapped in the native output shape, so
  // schema keys AND values carrying lone surrogates never reach the wire.
  it("sanitizes a lone surrogate in a response schema key and description (#18081 review)", async () => {
    await handleTextSmall(buildRuntime(), {
      prompt: "return structured data",
      responseSchema: {
        type: "object",
        description: `schema desc \uD83D`,
        properties: {
          goodField: { type: "string", description: "clean" },
          [`bad${"\uD83D"}`]: { type: "string", description: `also \uD83D` },
        },
      },
    } as never);
    expect(captured).toHaveLength(1);
    const raw = captured[0].toString("utf8");
    expect(LONE_SURROGATE_ESCAPE.test(raw)).toBe(false);
    const body = new TextDecoder("utf-8", { fatal: true }).decode(captured[0]);
    expect((body as unknown as { isWellFormed: () => boolean }).isWellFormed()).toBe(true);
  });

  // #24698: the AI SDK jsonSchema() wrapper exposes its schema through
  // enumerable lazy accessors, so deepToWellFormedUnicode over the assembled
  // tool set failed closed on the #23159 accessor guard. Caller-controlled
  // strings are now sanitized pre-wrap inside readToolSet; the assembled set
  // is never deep-walked. A pre-built SDK tool (lazy inputSchema accessors,
  // shaped like the real jsonSchema() wrapper) passed through a Record must
  // reach the wire sanitized instead of throwing WELL_FORMED_UNSAFE_VALUE.
  it("sanitizes an SDK passthrough tool description without walking its lazy schema accessors (#24698)", async () => {
    const lazySchema = { type: "object" as const, properties: {} };
    const sdkTool = {
      inputSchema: jsonSchema(lazySchema),
      description: `sdk tool \uD83D`,
    };
    const result = await handleTextSmall(buildRuntime(), {
      prompt: "use the sdk tool",
      tools: { sdk_passthrough: sdkTool },
    } as never);
    expect(typeof result === "string" ? result : (result as { text: string }).text).toBe("ok");

    expect(captured).toHaveLength(1);
    const raw = captured[0].toString("utf8");
    expect(LONE_SURROGATE_ESCAPE.test(raw)).toBe(false);
    const body = new TextDecoder("utf-8", { fatal: true }).decode(captured[0]);
    expect((body as unknown as { isWellFormed: () => boolean }).isWellFormed()).toBe(true);
    const serialized = JSON.stringify(JSON.parse(body));
    expect(serialized).toContain(`sdk tool ${String.fromCharCode(0xfffd)}`);
  });

  // #24698: array-form named tools also build through readToolSet; a lone
  // surrogate in the tool NAME must sanitize without colliding or throwing.
  it("sanitizes a lone surrogate in an array-form named tool name (#24698)", async () => {
    const result = await handleTextSmall(buildRuntime(), {
      prompt: "use the named tool",
      tools: [
        {
          name: `named_tool_\uD83D`,
          description: "clean description",
          parameters: { type: "object", properties: {} },
        },
      ],
    } as never);
    expect(typeof result === "string" ? result : (result as { text: string }).text).toBe("ok");

    expect(captured).toHaveLength(1);
    const raw = captured[0].toString("utf8");
    expect(LONE_SURROGATE_ESCAPE.test(raw)).toBe(false);
    const body = new TextDecoder("utf-8", { fatal: true }).decode(captured[0]);
    expect((body as unknown as { isWellFormed: () => boolean }).isWellFormed()).toBe(true);
    const serialized = JSON.stringify(JSON.parse(body));
    expect(serialized).toContain(`named_tool_${String.fromCharCode(0xfffd)}`);
  });

  // #24698 review round 1: a pre-built SDK tool's WRAPPED schema can itself
  // carry a lone surrogate. The passthrough path unwraps the SDK's own
  // jsonSchema() wrapper (the same getter read enforceAnthropicStrictToolBudget
  // performs), sanitizes, and rewraps — the surrogate must not reach the wire.
  it("sanitizes a lone surrogate inside a passthrough tool's wrapped schema (#24698)", async () => {
    const result = await handleTextSmall(buildRuntime(), {
      prompt: "use the sdk tool",
      tools: {
        sdk_dirty_schema: {
          inputSchema: jsonSchema({ type: "object" as const, description: `dirty \uD83D` }),
          description: "clean",
        },
      },
    } as never);
    expect(typeof result === "string" ? result : (result as { text: string }).text).toBe("ok");

    expect(captured).toHaveLength(1);
    const raw = captured[0].toString("utf8");
    expect(LONE_SURROGATE_ESCAPE.test(raw)).toBe(false);
    const body = new TextDecoder("utf-8", { fatal: true }).decode(captured[0]);
    expect((body as unknown as { isWellFormed: () => boolean }).isWellFormed()).toBe(true);
  });

  // #24698 review round 1: record keys become tool names on the wire.
  it("sanitizes a lone surrogate in a passthrough record key (#24698)", async () => {
    const result = await handleTextSmall(buildRuntime(), {
      prompt: "use the sdk tool",
      tools: {
        [`bad_key_\uD83D`]: {
          inputSchema: jsonSchema({ type: "object" as const }),
          description: "clean",
        },
      },
    } as never);
    expect(typeof result === "string" ? result : (result as { text: string }).text).toBe("ok");

    expect(captured).toHaveLength(1);
    const raw = captured[0].toString("utf8");
    expect(LONE_SURROGATE_ESCAPE.test(raw)).toBe(false);
    const body = new TextDecoder("utf-8", { fatal: true }).decode(captured[0]);
    expect((body as unknown as { isWellFormed: () => boolean }).isWellFormed()).toBe(true);
  });

  // #24698 review round 1: two DISTINCT names that collapse onto the same
  // sanitized form must reject loudly, not silently drop a tool. Exact
  // duplicates of the same source name keep develop's overwrite semantics.
  it("rejects distinct tool names that collide after sanitization (#24698)", async () => {
    await expect(
      handleTextSmall(buildRuntime(), {
        prompt: "use the tools",
        tools: [
          { name: `tool_a_\uD83D`, description: "one", parameters: { type: "object" } },
          { name: `tool_a_\uDFFF`, description: "two", parameters: { type: "object" } },
        ],
      } as never)
    ).rejects.toMatchObject({
      code: "ANTHROPIC_TOOL_NAME_COLLISION",
    } satisfies Partial<ElizaError>);
    expect(captured).toHaveLength(0);
  });

  // #24698 review round 2, F4: a non-object entry inside a passthrough
  // Record must fail closed, not be silently dropped by the rebuild.
  it("rejects a non-object entry inside a passthrough tool record (#24698)", async () => {
    await expect(
      handleTextSmall(buildRuntime(), {
        prompt: "use the tools",
        tools: {
          good_tool: {
            inputSchema: jsonSchema({ type: "object" as const }),
            description: "clean",
          },
          junk: "not a tool" as unknown as never,
        },
      } as never)
    ).rejects.toMatchObject({
      code: "ANTHROPIC_INVALID_TOOL_ENTRY",
    } satisfies Partial<ElizaError>);
    expect(captured).toHaveLength(0);
  });

  // #24698 review round 2, F2: a custom `validate` on the SDK wrapper must
  // survive sanitization — the wrapper is rebuilt descriptor-preserving, not
  // replaced by a default jsonSchema() wrapper.
  it("preserves a custom validate callback when sanitizing a passthrough tool schema (#24698)", async () => {
    const customValidate = (): { success: true; value: { ok: boolean } } => ({
      success: true,
      value: { ok: true },
    });
    const wrapped = jsonSchema(
      { type: "object" as const, description: `dirty \uD83D` },
      {
        validate: customValidate,
      }
    );
    const result = await handleTextSmall(buildRuntime(), {
      prompt: "use the sdk tool",
      tools: { sdk_custom_validate: { inputSchema: wrapped, description: "clean" } },
    } as never);
    expect(typeof result === "string" ? result : (result as { text: string }).text).toBe("ok");
    expect(captured).toHaveLength(1);
    const raw = captured[0].toString("utf8");
    expect(LONE_SURROGATE_ESCAPE.test(raw)).toBe(false);
    // The sanitized wrapper must still carry the caller's validate reference:
    // the wrapper was rebuilt descriptor-preserving, not replaced by a
    // default jsonSchema() wrapper (r2 F2 / r3 F3).
    expect(wrapped.validate).toBe(customValidate);
    const validateResult = wrapped.validate?.(undefined);
    expect(validateResult).toEqual({ success: true, value: { ok: true } });
  });

  // #24698 review round 3, F3 behavioral pin: the rebuilt wrapper must keep
  // `validate` SEMANTICALLY live, not just present on the object. A tool_use
  // reply makes the SDK parse tool input through inputSchema.validate; a
  // failing validate must surface as an invalid tool call carrying this
  // probe's marker error. If the rebuild dropped validate (regression back to
  // a default jsonSchema() wrapper), the call would parse as valid.
  it("keeps a rebuilt wrapper's validate in the SDK tool-input parse path (#24698)", async () => {
    let validateCalls = 0;
    const wrapped = jsonSchema(
      { type: "object" as const, description: `dirty \uD83D` },
      {
        validate: (_value: unknown): { success: false; error: string } => {
          validateCalls += 1;
          return { success: false, error: "probe-validate-reject" };
        },
      }
    );
    const result = (await handleTextSmall(buildRuntime(), {
      prompt: "force tool use: sdk_custom_validate",
      tools: { sdk_custom_validate: { inputSchema: wrapped, description: "clean" } },
    } as never)) as { toolCalls?: Array<Record<string, unknown>> };
    expect(captured).toHaveLength(1);
    expect(LONE_SURROGATE_ESCAPE.test(captured[0].toString("utf8"))).toBe(false);
    expect(validateCalls).toBe(1);
    const toolCall = result.toolCalls?.[0];
    expect(toolCall).toMatchObject({
      toolName: "sdk_custom_validate",
      invalid: true,
    });
    const error = toolCall?.error as { cause?: { cause?: unknown } } | undefined;
    expect(error?.cause?.cause).toBe("probe-validate-reject");
  });

  // #24698 review round 2, F1: dirty description (forcing the clone path) +
  // dirty wrapped schema + an unrelated own `value` property on the tool —
  // the descriptor selection must still find inputSchema on the cloned tool,
  // not misread the clone as a descriptor.
  it("sanitizes a passthrough tool with a dirty description, dirty schema, and a value property (#24698)", async () => {
    const result = await handleTextSmall(buildRuntime(), {
      prompt: "use the sdk tool",
      tools: {
        sdk_mixed: {
          inputSchema: jsonSchema({ type: "object" as const, description: `dirty \uD83D` }),
          description: `also dirty \uD83D`,
          value: "unrelated-own-property",
        },
      } as never,
    });
    expect(typeof result === "string" ? result : (result as { text: string }).text).toBe("ok");
    expect(captured).toHaveLength(1);
    const raw = captured[0].toString("utf8");
    expect(LONE_SURROGATE_ESCAPE.test(raw)).toBe(false);
    const body = new TextDecoder("utf-8", { fatal: true }).decode(captured[0]);
    expect((body as unknown as { isWellFormed: () => boolean }).isWellFormed()).toBe(true);
  });

  // #24698 review round 3, F1 / round 4, F2: provider-serialized data beyond
  // description and inputSchema must not bypass sanitization. Two observable
  // pins at this boundary: (a) a dirty extra string never reaches the captured
  // wire bytes; (b) a CYCLIC extra field is caught by the whole-tool walk
  // (WELL_FORMED_UNBOUNDED) before the SDK sees the tool — proving the walk
  // actually traverses extra fields rather than the SDK silently dropping
  // them making the test pass vacuously.
  it("sanitizes a dirty extra field on a passthrough tool before the wire (#24698)", async () => {
    const result = await handleTextSmall(buildRuntime(), {
      prompt: "use the sdk tool",
      tools: {
        sdk_extra_dirty: {
          inputSchema: jsonSchema({ type: "object" as const }),
          description: "clean",
          extraField: `extra dirty \uD83D`,
        },
      },
    } as never);
    expect(typeof result === "string" ? result : (result as { text: string }).text).toBe("ok");
    expect(captured).toHaveLength(1);
    const raw = captured[0].toString("utf8");
    expect(LONE_SURROGATE_ESCAPE.test(raw)).toBe(false);
    const body = new TextDecoder("utf-8", { fatal: true }).decode(captured[0]);
    expect((body as unknown as { isWellFormed: () => boolean }).isWellFormed()).toBe(true);
  });

  it("fails closed on a cyclic extra field on a passthrough tool (#24698)", async () => {
    const cyclic: Record<string, unknown> = { label: "node" };
    cyclic.self = cyclic;
    await expect(
      handleTextSmall(buildRuntime(), {
        prompt: "use the sdk tool",
        tools: {
          sdk_extra_cyclic: {
            inputSchema: jsonSchema({ type: "object" as const }),
            description: "clean",
            extraField: cyclic,
          },
        },
      } as never)
    ).rejects.toMatchObject({
      code: "WELL_FORMED_UNBOUNDED",
      context: { reason: "cycle" },
    } satisfies Partial<ElizaError>);
    expect(captured).toHaveLength(0);
  });

  // #24698 review round 3, F2: accessor-valued tool fields on a passthrough
  // tool must fail closed with the typed accessor error rather than silently
  // serializing their getter output to the wire.
  it("fails closed on an inputSchema accessor on a passthrough tool (#24698)", async () => {
    const wrapper = jsonSchema({ type: "object" as const, description: `dirty \uD83D` });
    await expect(
      handleTextSmall(buildRuntime(), {
        prompt: "use the sdk tool",
        tools: {
          accessor_tool: {
            get inputSchema() {
              return wrapper;
            },
            description: "clean",
          },
        } as never,
      })
    ).rejects.toMatchObject({
      code: "WELL_FORMED_UNSAFE_VALUE",
      context: { operation: "accessor" },
    } satisfies Partial<ElizaError>);
    expect(captured).toHaveLength(0);
  });

  it("fails closed on a description accessor on a passthrough tool (#24698)", async () => {
    await expect(
      handleTextSmall(buildRuntime(), {
        prompt: "use the sdk tool",
        tools: {
          desc_getter: {
            get description() {
              return `dirty \uD83D`;
            },
            inputSchema: jsonSchema({ type: "object" as const }),
          },
        } as never,
      })
    ).rejects.toMatchObject({
      code: "WELL_FORMED_UNSAFE_VALUE",
      context: { operation: "accessor" },
    } satisfies Partial<ElizaError>);
    expect(captured).toHaveLength(0);
  });

  // #24698 review round 4, F1: an enumerable accessor on a NAMED tool's
  // wire-relevant fields must fail closed with a typed error naming the
  // property — descriptor-safe reads, no getter invocation. The getter body
  // throws if executed, proving zero-invocation from the plugin side.
  it("fails closed without invoking a name accessor on a named tool (#24698)", async () => {
    let getterCalls = 0;
    await expect(
      handleTextSmall(buildRuntime(), {
        prompt: "use the tools",
        tools: [
          {
            get name() {
              getterCalls += 1;
              return "acc_named";
            },
            parameters: { type: "object" },
          },
        ],
      } as never)
    ).rejects.toMatchObject({
      code: "ANTHROPIC_UNSAFE_TOOL_FIELD",
      context: { propertyName: "name" },
    } satisfies Partial<ElizaError>);
    expect(getterCalls).toBe(0);
    expect(captured).toHaveLength(0);
  });

  it("fails closed without invoking a parameters accessor on a named tool (#24698)", async () => {
    let getterCalls = 0;
    await expect(
      handleTextSmall(buildRuntime(), {
        prompt: "use the tools",
        tools: [
          {
            name: "acc_named",
            get parameters() {
              getterCalls += 1;
              return { type: "object" };
            },
          },
        ],
      } as never)
    ).rejects.toMatchObject({
      code: "ANTHROPIC_UNSAFE_TOOL_FIELD",
      context: { propertyName: "parameters" },
    } satisfies Partial<ElizaError>);
    expect(getterCalls).toBe(0);
    expect(captured).toHaveLength(0);
  });

  // #24698 review round 4, F1: an enumerable accessor on the tool-set
  // CONTAINER must fail closed without invocation; Object.entries would have
  // executed it silently.
  it("fails closed without invoking an accessor entry on the tool container (#24698)", async () => {
    let getterCalls = 0;
    const tools: Record<string, unknown> = {
      real_tool: { name: "real_tool", parameters: { type: "object" } },
    };
    Object.defineProperty(tools, "hostile_entry", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return { name: "hostile", parameters: { type: "object" } };
      },
    });
    await expect(
      handleTextSmall(buildRuntime(), {
        prompt: "use the tools",
        tools,
      } as never)
    ).rejects.toMatchObject({
      code: "ANTHROPIC_UNSAFE_TOOL_CONTAINER",
    } satisfies Partial<ElizaError>);
    expect(getterCalls).toBe(0);
    expect(captured).toHaveLength(0);
  });

  // #24698 review round 5, F2 / round 6: a Proxy CONTAINER can report a
  // benign DATA descriptor from getOwnPropertyDescriptor and still run
  // hostile code when the entry value is re-read as a property
  // (`container[key]`). The fixed path consumes descriptor.value from the
  // same single inspection — the container's get trap must never fire.
  // Proxying the outer tools record (not an inner tool) is what
  // discriminates: the pre-fix property read fires the trap; the fixed
  // descriptor read does not.
  it("does not re-read container entries after descriptor inspection (#24698)", async () => {
    let valueReads = 0;
    const proxyEntryTool = { name: "proxy_tool", parameters: { type: "object" } };
    const proxiedContainer = new Proxy(
      { real_tool: { name: "real_tool", parameters: { type: "object" } } },
      {
        getOwnPropertyDescriptor(target, prop) {
          if (prop === "proxy_entry") {
            return {
              configurable: true,
              enumerable: true,
              writable: true,
              value: proxyEntryTool,
            };
          }
          return Reflect.getOwnPropertyDescriptor(target, prop);
        },
        ownKeys(target) {
          return [...Reflect.ownKeys(target), "proxy_entry"];
        },
        get(target, prop) {
          valueReads += 1;
          return Reflect.get(target, prop);
        },
      }
    );
    const result = await handleTextSmall(buildRuntime(), {
      prompt: "use the tools",
      tools: proxiedContainer,
    } as never);
    expect(typeof result === "string" ? result : (result as { text: string }).text).toBe("ok");
    // The container's get trap never ran: every entry value was consumed
    // from the inspected descriptor, never re-read as a property.
    expect(valueReads).toBe(0);
    expect(captured).toHaveLength(1);
    const raw = captured[0].toString("utf8");
    expect(LONE_SURROGATE_ESCAPE.test(raw)).toBe(false);
    const body = new TextDecoder("utf-8", { fatal: true }).decode(captured[0]);
    expect((body as unknown as { isWellFormed: () => boolean }).isWellFormed()).toBe(true);
    expect(raw).toContain("proxy_tool");
  });

  // #24698 review round 4, F3: a FORGED wrapper carrying the global marker as
  // an accessor (or with a non-true value) must not be unwrapped; the whole-
  // tool walk then fails closed on its enumerable accessors without invoking
  // them. Both the forged-marker getter and the jsonSchema getter must stay
  // uninvoked from the plugin side.
  it("fails closed on a forged marker wrapper without invoking its accessors (#24698)", async () => {
    let markerGets = 0;
    let schemaGets = 0;
    const forged = {
      get [Symbol.for("vercel.ai.schema")]() {
        markerGets += 1;
        return true;
      },
      get jsonSchema() {
        schemaGets += 1;
        return { type: "object", description: `dirty \uD83D` };
      },
      _type: "jsonSchema" as const,
    };
    await expect(
      handleTextSmall(buildRuntime(), {
        prompt: "use the sdk tool",
        tools: { forged_tool: { inputSchema: forged, description: "clean" } },
      } as never)
    ).rejects.toMatchObject({
      code: "WELL_FORMED_UNSAFE_VALUE",
      context: { operation: "accessor" },
    } satisfies Partial<ElizaError>);
    expect(markerGets).toBe(0);
    expect(schemaGets).toBe(0);
    expect(captured).toHaveLength(0);
  });

  it("fails closed on a non-true marker value wrapper (#24698)", async () => {
    let schemaGets = 0;
    const forged = {
      [Symbol.for("vercel.ai.schema")]: "not-boolean-true",
      get jsonSchema() {
        schemaGets += 1;
        return { type: "object", description: `dirty \uD83D` };
      },
      _type: "jsonSchema" as const,
    };
    await expect(
      handleTextSmall(buildRuntime(), {
        prompt: "use the sdk tool",
        tools: { forged_value_tool: { inputSchema: forged, description: "clean" } },
      } as never)
    ).rejects.toMatchObject({
      code: "WELL_FORMED_UNSAFE_VALUE",
      context: { operation: "accessor" },
    } satisfies Partial<ElizaError>);
    // The marker value is not exactly true, so the unwrap gate must skip the
    // wrapper entirely: its lazy jsonSchema getter stays uninvoked and the
    // whole-tool walk fails closed on the accessor instead.
    expect(schemaGets).toBe(0);
    expect(captured).toHaveLength(0);
  });
});
