/**
 * Covers extractActionParamsViaLlm: missing-slot detection, planner-wins
 * merge, prompt construction (schema / conversation / speaker), JSON parse
 * fallbacks, and model-failure recovery. The helper is the system under test;
 * useModel is a stub that returns real JSON text so parseJSONObjectFromText
 * runs for real.
 */
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractActionParamsViaLlm,
  type ParamSchemaDescriptor,
} from "./extract-params.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const SCHEMA: readonly ParamSchemaDescriptor[] = [
  {
    name: "subaction",
    description: "Inbox operation to run",
    required: true,
    schema: { type: "string", enum: ["search", "digest", "respond"] },
  },
  {
    name: "query",
    description: "Search query",
    schema: { type: "string" },
  },
  {
    name: "limit",
    description: "Max results",
    schema: { type: "number" },
  },
];

type Params = {
  subaction?: string | null;
  query?: string | null;
  limit?: number | null;
  extra?: unknown;
};

function message(text: unknown = "search github"): Memory {
  return { content: { text } } as unknown as Memory;
}

function conversationState(
  rows: Array<{
    text?: unknown;
    content?: unknown;
    metadata?: Memory["metadata"];
  }>,
): State {
  const recentMessages = rows.map((row) => ({
    content: row.content !== undefined ? row.content : { text: row.text },
    metadata: row.metadata,
  }));
  return {
    data: {
      providers: {
        RECENT_MESSAGES: { data: { recentMessages } },
      },
    },
  } as unknown as State;
}

function runtime(
  useModel: IAgentRuntime["useModel"] = vi.fn(
    async () => '{"subaction":"search"}',
  ),
): { runtime: IAgentRuntime; useModel: IAgentRuntime["useModel"] } {
  return {
    runtime: { useModel } as unknown as IAgentRuntime,
    useModel,
  };
}

function extract(
  overrides: {
    runtime?: IAgentRuntime;
    message?: Memory;
    state?: State;
    existingParams?: Partial<Params>;
    requiredFields?: ReadonlyArray<keyof Params & string>;
    paramSchema?: readonly ParamSchemaDescriptor[];
    modelType?: (typeof ModelType)[keyof typeof ModelType];
    recentMessagesLimit?: number;
    actionName?: string;
    actionDescription?: string;
  } = {},
) {
  const { runtime: rt, useModel } = overrides.runtime
    ? { runtime: overrides.runtime, useModel: overrides.runtime.useModel }
    : runtime();
  return {
    useModel,
    promise: extractActionParamsViaLlm<Params>({
      runtime: rt,
      message: overrides.message ?? message(),
      state: overrides.state,
      actionName: overrides.actionName ?? "MESSAGE",
      actionDescription:
        overrides.actionDescription ??
        "Cross-channel inbox: triage / digest / respond / search",
      paramSchema: overrides.paramSchema ?? SCHEMA,
      existingParams: overrides.existingParams ?? {},
      requiredFields: overrides.requiredFields ?? ["subaction"],
      modelType: overrides.modelType,
      recentMessagesLimit: overrides.recentMessagesLimit,
    }),
  };
}

describe("extractActionParamsViaLlm", () => {
  describe("short-circuit when required fields are already present", () => {
    it("returns the same object and skips the model when every required field is filled", async () => {
      const existingParams = { subaction: "digest", query: "github" };
      const { useModel, promise } = extract({ existingParams });
      const result = await promise;
      expect(result).toBe(existingParams);
      expect(useModel).not.toHaveBeenCalled();
    });

    it('treats 0, false, and empty arrays as present (only null/undefined/"" are missing)', async () => {
      const existingParams = {
        subaction: "search",
        limit: 0,
        extra: false,
      };
      const { useModel, promise } = extract({
        existingParams,
        requiredFields: ["subaction", "limit"],
      });
      expect(await promise).toBe(existingParams);
      expect(useModel).not.toHaveBeenCalled();
    });

    it("skips the model when requiredFields is empty", async () => {
      const existingParams = {};
      const { useModel, promise } = extract({
        existingParams,
        requiredFields: [],
      });
      expect(await promise).toBe(existingParams);
      expect(useModel).not.toHaveBeenCalled();
    });

    it("does not treat schema.required as the missing-field source", async () => {
      const existingParams = { query: "github" };
      const { useModel, promise } = extract({
        existingParams,
        requiredFields: ["query"],
      });
      // subaction is required:true on the schema, but not in requiredFields.
      expect(await promise).toBe(existingParams);
      expect(useModel).not.toHaveBeenCalled();
    });
  });

  describe("missing-field detection", () => {
    it.each([
      { label: "undefined", existingParams: {} },
      { label: "null", existingParams: { subaction: null } },
      { label: "empty string", existingParams: { subaction: "" } },
    ])(
      "calls the model when $label is the required value",
      async ({ existingParams }) => {
        const { useModel, promise } = extract({ existingParams });
        await promise;
        expect(useModel).toHaveBeenCalledTimes(1);
      },
    );

    it("does not treat a whitespace-only string as missing", async () => {
      const existingParams = { subaction: "  " };
      const { useModel, promise } = extract({ existingParams });
      expect(await promise).toBe(existingParams);
      expect(useModel).not.toHaveBeenCalled();
    });
  });

  describe("model invocation and prompt construction", () => {
    it("calls TEXT_SMALL with stopSequences: [] by default", async () => {
      const { useModel, promise } = extract({
        existingParams: { subaction: null },
      });
      await promise;
      expect(useModel).toHaveBeenCalledWith(ModelType.TEXT_SMALL, {
        prompt: expect.any(String),
        stopSequences: [],
      });
    });

    it("forwards an explicit modelType override", async () => {
      const { useModel, promise } = extract({
        existingParams: { subaction: null },
        modelType: ModelType.TEXT_LARGE,
      });
      await promise;
      expect(useModel).toHaveBeenCalledWith(
        ModelType.TEXT_LARGE,
        expect.objectContaining({ stopSequences: [] }),
      );
    });

    it("renders schema types, enums, and [REQUIRED] only for still-missing fields", async () => {
      const { useModel, promise } = extract({
        existingParams: { query: "github", subaction: "" },
        requiredFields: ["subaction"],
      });
      await promise;
      const prompt = (useModel as ReturnType<typeof vi.fn>).mock.calls[0][1]
        .prompt as string;
      expect(prompt).toContain("MESSAGE");
      expect(prompt).toContain(
        "Cross-channel inbox: triage / digest / respond / search",
      );
      expect(prompt).toContain(
        "  - subaction (string) [one of: search | digest | respond] [REQUIRED]: Inbox operation to run",
      );
      expect(prompt).toContain("  - query (string): Search query");
      expect(prompt).not.toContain("query (string) [REQUIRED]");
      expect(prompt).toContain(
        "Missing required fields you must extract: subaction",
      );
      expect(prompt).toContain('{"query":"github","subaction":""}');
    });

    it("trims the current message and substitutes (empty) when text is blank or non-string", async () => {
      const { useModel: trimmedModel, promise: trimmed } = extract({
        message: message("  search github  "),
        existingParams: { subaction: null },
      });
      await trimmed;
      const trimmedPrompt = (trimmedModel as ReturnType<typeof vi.fn>).mock
        .calls[0][1].prompt as string;
      expect(trimmedPrompt).toContain("Current user message: search github");

      const { useModel: emptyModel, promise: empty } = extract({
        runtime: runtime(vi.fn(async () => '{"subaction":"search"}')).runtime,
        message: message("   "),
        existingParams: { subaction: null },
      });
      await empty;
      expect(
        (emptyModel as ReturnType<typeof vi.fn>).mock.calls[0][1].prompt,
      ).toContain("Current user message: (empty)");

      const { useModel: nonStringModel, promise: nonString } = extract({
        runtime: runtime(vi.fn(async () => '{"subaction":"search"}')).runtime,
        message: message(42),
        existingParams: { subaction: null },
      });
      await nonString;
      expect(
        (nonStringModel as ReturnType<typeof vi.fn>).mock.calls[0][1].prompt,
      ).toContain("Current user message: (empty)");
    });
  });

  describe("conversation context and speaker names", () => {
    it("uses the no-conversation placeholder when state is absent or empty", async () => {
      const { useModel: noStateModel, promise: noState } = extract({
        existingParams: { subaction: null },
      });
      await noState;
      expect(
        (noStateModel as ReturnType<typeof vi.fn>).mock.calls[0][1].prompt,
      ).toContain("(no recent conversation context)");

      const { useModel: emptyModel, promise: empty } = extract({
        runtime: runtime(vi.fn(async () => '{"subaction":"search"}')).runtime,
        state: conversationState([]),
        existingParams: { subaction: null },
      });
      await empty;
      expect(
        (emptyModel as ReturnType<typeof vi.fn>).mock.calls[0][1].prompt,
      ).toContain("(no recent conversation context)");
    });

    it("formats oldest-first conversation lines and drops empty / non-object content", async () => {
      const { useModel, promise } = extract({
        existingParams: { subaction: null },
        recentMessagesLimit: 1,
        state: conversationState([
          { text: "first" },
          { text: "   " },
          { content: "not-an-object" },
          { content: { text: 7 } },
          { text: "second" },
        ]),
      });
      await promise;
      const prompt = (useModel as ReturnType<typeof vi.fn>).mock.calls[0][1]
        .prompt as string;
      expect(prompt).toContain(
        "Recent conversation (oldest first):\nuser: first\nuser: second",
      );
      // Deprecated limit is ignored — both real lines remain.
      expect(prompt).toContain("user: first");
      expect(prompt).toContain("user: second");
    });

    it("prefers sender.name, then entityName, then entityUserName, else user", async () => {
      const { useModel, promise } = extract({
        existingParams: { subaction: null },
        state: conversationState([
          {
            text: "from-sender",
            metadata: {
              sender: { name: "Alice" },
              entityName: "Ignored",
              entityUserName: "also-ignored",
            } as Memory["metadata"],
          },
          {
            text: "from-entity",
            metadata: {
              sender: "not-an-object",
              entityName: "Bob",
              entityUserName: "bob-user",
            } as unknown as Memory["metadata"],
          },
          {
            text: "from-username",
            metadata: {
              entityName: 12,
              entityUserName: "carol",
            } as unknown as Memory["metadata"],
          },
          { text: "anonymous" },
        ]),
      });
      await promise;
      const prompt = (useModel as ReturnType<typeof vi.fn>).mock.calls[0][1]
        .prompt as string;
      expect(prompt).toContain("Alice: from-sender");
      expect(prompt).toContain("Bob: from-entity");
      expect(prompt).toContain("carol: from-username");
      expect(prompt).toContain("user: anonymous");
    });
  });

  describe("parse, merge, and fallbacks", () => {
    it("fills missing slots from extracted JSON while planner values win on collision", async () => {
      const { runtime: rt } = runtime(
        vi.fn(
          async () => '{"subaction":"search","query":"extracted","limit":5}',
        ),
      );
      const existingParams = { subaction: "", query: "planner-query" };
      const { promise } = extract({
        runtime: rt,
        existingParams,
        requiredFields: ["subaction"],
      });
      expect(await promise).toEqual({
        subaction: "search",
        query: "planner-query",
        limit: 5,
      });
    });

    it("drops null extracted fields so they cannot clobber a later merge", async () => {
      const { runtime: rt } = runtime(
        vi.fn(async () => '{"subaction":null,"query":"kept"}'),
      );
      const { promise } = extract({
        runtime: rt,
        existingParams: { subaction: null },
      });
      expect(await promise).toEqual({ query: "kept" });
    });

    it("parses fenced JSON through the real object parser", async () => {
      const { runtime: rt } = runtime(
        vi.fn(async () => 'sure:\n```json\n{"subaction":"digest"}\n```\ndone'),
      );
      const { promise } = extract({
        runtime: rt,
        existingParams: { subaction: null },
      });
      expect(await promise).toEqual({ subaction: "digest" });
    });

    it.each([
      { label: "empty string", raw: "   " },
      { label: "non-object JSON", raw: "[1,2,3]" },
      { label: "unparseable prose", raw: "not json at all" },
      { label: "non-string model result", raw: { not: "json" } },
    ])(
      "returns existingParams unchanged when the model yields $label",
      async ({ raw }) => {
        const existingParams = { subaction: null, query: "keep-me" };
        const { runtime: rt } = runtime(vi.fn(async () => raw as never));
        const { promise } = extract({ runtime: rt, existingParams });
        expect(await promise).toBe(existingParams);
      },
    );

    it("keeps existingParams when useModel throws, and logs the action-scoped warning", async () => {
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      const existingParams = { query: "keep-me" };
      const { runtime: rt } = runtime(
        vi.fn(async () => {
          throw new Error("provider down");
        }),
      );
      const { promise } = extract({
        runtime: rt,
        existingParams,
        actionName: "MESSAGE",
      });
      expect(await promise).toBe(existingParams);
      expect(warn).toHaveBeenCalledWith(
        "[MESSAGE] LLM param extraction failed: provider down",
      );

      const { runtime: rt2 } = runtime(
        vi.fn(async () => {
          throw "bare-string";
        }),
      );
      const existing2 = { query: "still" };
      const { promise: p2 } = extract({
        runtime: rt2,
        existingParams: existing2,
        actionName: "MESSAGE",
      });
      expect(await p2).toBe(existing2);
      expect(warn).toHaveBeenCalledWith(
        "[MESSAGE] LLM param extraction failed: bare-string",
      );
    });

    it("copies extra non-empty planner keys onto the merged result", async () => {
      const { runtime: rt } = runtime(
        vi.fn(async () => '{"subaction":"respond"}'),
      );
      const { promise } = extract({
        runtime: rt,
        existingParams: { extra: { nested: true }, subaction: "" },
      });
      expect(await promise).toEqual({
        extra: { nested: true },
        subaction: "respond",
      });
    });
  });
});
