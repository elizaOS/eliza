/**
 * Exercises parameter extraction through the real prompt, parsing, and merge
 * paths while replacing only the external model call with deterministic text.
 */
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractActionParamsViaLlm,
  type ParamSchemaDescriptor,
} from "./extract-params.ts";

interface Params {
  subaction?: string | null;
  query?: string | null;
  limit?: number;
}

const paramSchema: readonly ParamSchemaDescriptor[] = [
  {
    name: "subaction",
    description: "Operation to run",
    required: true,
    schema: { type: "string", enum: ["search", "digest"] },
  },
  {
    name: "query",
    description: "Search terms",
    schema: { type: "string" },
  },
  { name: "limit", description: "Maximum results" },
];

function message(text: unknown = "search github"): Memory {
  return { content: { text } } as unknown as Memory;
}

function stateWithMessages(
  messages: Array<{ content: unknown; metadata?: Memory["metadata"] }>,
): State {
  return {
    data: {
      providers: {
        RECENT_MESSAGES: { data: { recentMessages: messages } },
      },
    },
  } as unknown as State;
}

function runtimeReturning(raw: unknown): {
  runtime: IAgentRuntime;
  useModel: ReturnType<typeof vi.fn>;
} {
  const useModel = vi.fn(async () => raw);
  return {
    runtime: { useModel } as unknown as IAgentRuntime,
    useModel,
  };
}

function extract(
  runtime: IAgentRuntime,
  overrides: Partial<{
    message: Memory;
    state: State;
    existingParams: Partial<Params>;
    requiredFields: ReadonlyArray<keyof Params & string>;
    modelType: (typeof ModelType)[keyof typeof ModelType];
    recentMessagesLimit: number;
  }> = {},
) {
  return extractActionParamsViaLlm<Params>({
    runtime,
    message: overrides.message ?? message(),
    state: overrides.state,
    actionName: "MESSAGE",
    actionDescription: "Search or digest the inbox",
    paramSchema,
    existingParams: overrides.existingParams ?? {},
    requiredFields: overrides.requiredFields ?? ["subaction"],
    modelType: overrides.modelType,
    recentMessagesLimit: overrides.recentMessagesLimit,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("extractActionParamsViaLlm", () => {
  it("returns the original params without a model call when required values are present", async () => {
    const { runtime, useModel } = runtimeReturning('{"subaction":"search"}');
    const existingParams = { subaction: "digest", limit: 0 };

    await expect(
      extract(runtime, {
        existingParams,
        requiredFields: ["subaction", "limit"],
      }),
    ).resolves.toBe(existingParams);
    expect(useModel).not.toHaveBeenCalled();
  });

  it.each([
    ["undefined", {}],
    ["null", { subaction: null }],
    ["empty string", { subaction: "" }],
  ])("extracts when a required value is %s", async (_label, existingParams) => {
    const { runtime, useModel } = runtimeReturning('{"subaction":"search"}');

    await expect(extract(runtime, { existingParams })).resolves.toEqual({
      subaction: "search",
    });
    expect(useModel).toHaveBeenCalledOnce();
  });

  it("treats whitespace and an empty requiredFields list as already satisfied", async () => {
    const whitespace = runtimeReturning('{"subaction":"search"}');
    const emptyList = runtimeReturning('{"subaction":"search"}');

    await expect(
      extract(whitespace.runtime, { existingParams: { subaction: "  " } }),
    ).resolves.toEqual({ subaction: "  " });
    await expect(
      extract(emptyList.runtime, { requiredFields: [] }),
    ).resolves.toEqual({});
    expect(whitespace.useModel).not.toHaveBeenCalled();
    expect(emptyList.useModel).not.toHaveBeenCalled();
  });

  it("builds the focused prompt and uses TEXT_SMALL by default", async () => {
    const { runtime, useModel } = runtimeReturning('{"subaction":"search"}');

    await extract(runtime, {
      message: message("  find github issues  "),
      existingParams: { subaction: "", query: "github" },
    });

    expect(useModel).toHaveBeenCalledWith(ModelType.TEXT_SMALL, {
      prompt: expect.any(String),
      stopSequences: [],
    });
    const prompt = useModel.mock.calls[0][1].prompt as string;
    expect(prompt).toContain("MESSAGE");
    expect(prompt).toContain("Search or digest the inbox");
    expect(prompt).toContain(
      "subaction (string) [one of: search | digest] [REQUIRED]: Operation to run",
    );
    expect(prompt).toContain("query (string): Search terms");
    expect(prompt).toContain('{"subaction":"","query":"github"}');
    expect(prompt).toContain("Current user message: find github issues");
  });

  it("forwards a model override and renders empty message/context placeholders", async () => {
    const { runtime, useModel } = runtimeReturning('{"subaction":"digest"}');

    await extract(runtime, {
      message: message(42),
      modelType: ModelType.TEXT_LARGE,
    });

    expect(useModel).toHaveBeenCalledWith(
      ModelType.TEXT_LARGE,
      expect.objectContaining({ stopSequences: [] }),
    );
    const prompt = useModel.mock.calls[0][1].prompt as string;
    expect(prompt).toContain("(no recent conversation context)");
    expect(prompt).toContain("Current user message: (empty)");
  });

  it("includes every non-empty recent message and applies speaker-name precedence", async () => {
    const { runtime, useModel } = runtimeReturning('{"subaction":"search"}');
    const state = stateWithMessages([
      {
        content: { text: "  first  " },
        metadata: {
          sender: { name: "Alice" },
          entityName: "Ignored",
        } as Memory["metadata"],
      },
      {
        content: { text: "second" },
        metadata: { entityName: "Bob" } as Memory["metadata"],
      },
      {
        content: { text: "third" },
        metadata: { entityUserName: "carol" } as Memory["metadata"],
      },
      { content: { text: "   " } },
      { content: "not-an-object" },
      { content: { text: "fourth" } },
    ]);

    await extract(runtime, { state, recentMessagesLimit: 1 });

    const prompt = useModel.mock.calls[0][1].prompt as string;
    expect(prompt).toContain(
      "Recent conversation (oldest first):\nAlice: first\nBob: second\ncarol: third\nuser: fourth",
    );
  });

  it("merges extracted fields underneath non-empty planner values", async () => {
    const { runtime } = runtimeReturning(
      '{"subaction":"search","query":"model","limit":5}',
    );

    await expect(
      extract(runtime, {
        existingParams: { subaction: "", query: "planner" },
      }),
    ).resolves.toEqual({
      subaction: "search",
      query: "planner",
      limit: 5,
    });
  });

  it("drops null extracted fields and accepts fenced JSON", async () => {
    const { runtime } = runtimeReturning(
      'result:\n```json\n{"subaction":null,"query":"github"}\n```',
    );

    await expect(
      extract(runtime, { existingParams: { subaction: null } }),
    ).resolves.toEqual({ query: "github" });
  });

  it.each([
    ["blank text", "   "],
    ["an array", "[1,2,3]"],
    ["invalid prose", "not json"],
    ["a non-string result", { subaction: "search" }],
  ])("returns the original params for %s", async (_label, raw) => {
    const { runtime } = runtimeReturning(raw);
    const existingParams = { subaction: null, query: "keep" };

    await expect(extract(runtime, { existingParams })).resolves.toBe(
      existingParams,
    );
  });

  it("returns the original params and warns when the model rejects", async () => {
    const useModel = vi.fn(async () => {
      throw new Error("provider down");
    });
    const runtime = { useModel } as unknown as IAgentRuntime;
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const existingParams = { query: "keep" };

    await expect(extract(runtime, { existingParams })).resolves.toBe(
      existingParams,
    );
    expect(warn).toHaveBeenCalledWith(
      "[MESSAGE] LLM param extraction failed: provider down",
    );
  });
});
