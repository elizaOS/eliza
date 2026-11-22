/** A host that skips post-turn review and the foreground facts stage (mobile)
 * still described and requested `facts` and `relationships` on every Stage-1
 * call, although both of their readers return there before doing any work. */
import type { JSONSchema, ResponseHandlerFieldContext } from "@elizaos/core";
import { ChannelType } from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import {
  makeMessage,
  makeRuntime,
  makeState,
  runStage1,
  stage1Response,
  useModelCalls,
} from "../__tests__/stage1/fixtures.ts";
import {
  factsFieldEvaluator,
  relationshipsFieldEvaluator,
} from "./builtin-field-evaluators.ts";

const MEMORY_FIELDS = [factsFieldEvaluator, relationshipsFieldEvaluator];
const MEMORY_FIELD_NAMES = MEMORY_FIELDS.map((field) => field.name);

afterEach(() => vi.unstubAllEnvs());

/** One direct-message Stage-1 call on `platform`: the HANDLE_RESPONSE schema it
 * sends, and how the turn ends when the model writes exactly that schema. */
async function stage1Call(platform: string) {
  vi.stubEnv("ELIZA_PLATFORM", platform);
  const response = stage1Response({ contexts: ["simple"], replyText: "hi" });
  const runtime = makeRuntime([response]);
  const model = runtime.useModel as ReturnType<typeof vi.fn>;
  const answer = model.getMockImplementation();
  let schema: JSONSchema | undefined;
  model.mockImplementation(async (...call: unknown[]) => {
    const params = call[1] as {
      tools?: Array<{ name?: string; parameters?: JSONSchema }>;
    };
    schema = params.tools?.find(
      (tool) => tool.name === "HANDLE_RESPONSE",
    )?.parameters;
    const written = response.toolCalls[0].arguments as Record<string, unknown>;
    for (const name of Object.keys(written))
      if (!schema?.properties?.[name]) delete written[name];
    return answer?.(...call);
  });
  const result = await runStage1({
    runtime,
    message: makeMessage({ channelType: ChannelType.DM, text: "hi" }),
  });
  expect(useModelCalls(runtime)).toHaveLength(1);
  if (!schema) throw new Error("Stage 1 sent no HANDLE_RESPONSE schema");
  return { schema, written: response.toolCalls[0].arguments, result };
}

it("leaves facts and relationships out of the Stage-1 schema only where nothing reads them", async () => {
  const desktop = await stage1Call("");
  const mobile = await stage1Call("android");

  const { facts, relationships, ...shared } = desktop.schema.properties ?? {};
  expect(facts).toEqual(factsFieldEvaluator.schema);
  expect(relationships).toEqual(relationshipsFieldEvaluator.schema);
  expect(desktop.schema.required).toEqual(
    expect.arrayContaining(MEMORY_FIELD_NAMES),
  );
  // Byte-for-byte the non-mobile schema without the two fields: every other
  // field is still described and required on mobile.
  expect(JSON.stringify(mobile.schema)).toBe(
    JSON.stringify({
      ...desktop.schema,
      properties: shared,
      required: desktop.schema.required?.filter(
        (name) => !MEMORY_FIELD_NAMES.includes(name),
      ),
    }),
  );

  // Each turn completes on a reply holding exactly the fields it was asked for.
  for (const name of MEMORY_FIELD_NAMES) {
    expect(desktop.written).toHaveProperty(name);
    expect(mobile.written).not.toHaveProperty(name);
  }
  for (const call of [desktop, mobile]) {
    expect(call.result.kind).toBe("direct_reply");
    if (call.result.kind === "direct_reply")
      expect(call.result.result.responseContent?.text).toBe("hi");
  }
});

it.each([
  ["", ChannelType.DM, true],
  // Group voice skips post-turn review, but off mobile the foreground facts
  // stage still validates and stores what Stage 1 extracted.
  ["", ChannelType.VOICE_GROUP, true],
  ["android", ChannelType.DM, false],
  ["android", ChannelType.VOICE_GROUP, false],
  ["ios", ChannelType.GROUP, false],
] as const)(
  "platform %j, channel %s requests memory extraction: %j",
  async (platform, channelType, requested) => {
    vi.stubEnv("ELIZA_PLATFORM", platform);
    const context = {
      runtime: makeRuntime([]),
      message: makeMessage({ channelType }),
      state: makeState(),
      senderRole: "OWNER",
      turnSignal: new AbortController().signal,
    } satisfies ResponseHandlerFieldContext;
    for (const field of MEMORY_FIELDS)
      expect(await field.shouldRun?.(context)).toBe(requested);
  },
);
