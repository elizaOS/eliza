/** PREPARED/UNRUN. Intended path: plugins/plugin-assistant/src/services/message/stage1-notes-producer.test.ts.
 * Real registry + owned normalizer only. Not full model/Stage1 lifetime or planner proof.
 * Added to V7 source candidate; still unrun pending exact execution admission.
 */
import { ResponseHandlerFieldRegistry, type IAgentRuntime, type Memory, type State } from "@elizaos/core";
import { createMockRuntime } from "@elizaos/testing";
import { describe, expect, it } from "vitest";
import { notesRequestEffectField } from "../../../../plugin-notes/src/request-effect.ts";
import { messageHandlerFromFieldResult } from "./stage1-output.ts";

async function producer(value: unknown, owner = true) {
  const runtime = createMockRuntime() as IAgentRuntime;
  const message = { id: "incoming-notes-read", agentId: runtime.agentId, roomId: "room", entityId: "owner",
    content: { text: "what did I write about ideas?" } } as Memory;
  const state = { values: {}, data: {}, text: "" } as State;
  const registry = new ResponseHandlerFieldRegistry();
  registry.register(notesRequestEffectField);
  const rawParsed = { shouldRespond: "RESPOND", contexts: ["notes"],
    intents: ["Read the existing ideas note"], requiresTool: true,
    replyEffectStatus: "pending", replyText: "", candidateActionNames: [],
    facts: [], relationships: [], addressedTo: [],
    ...(value === undefined ? {} : { notesRequestEffect: value }) };
  const fieldRun = await registry.dispatch({ rawParsed, runtime, message, state,
    senderRole: owner ? "OWNER" : "USER", turnSignal: new AbortController().signal });
  const normalize = (result = fieldRun.parsed, run = fieldRun) => messageHandlerFromFieldResult(
    result, run, { actions: [], messageText: String(message.content.text) });
  return { fieldRun, normalize };
}

describe("same-call Notes field producer", () => {
  it.each(["read_only", "mutation_requested", "unresolved"] as const)("carries the actual parsed and handled %s result", async classification => {
    const f = await producer(classification);
    expect(f.fieldRun.traces).toContainEqual(expect.objectContaining({ fieldName: "notesRequestEffect",
      active: true, parsed: true, handled: true, parseOutcome: "ok" }));
    expect(f.normalize().plan.notesRequestEffect).toBe(classification);
  });
  it.each([undefined, null, "allow", { classification: "mutation_requested" }])("malformed field %j cannot become a write grant", async value => {
    const f = await producer(value);
    expect(f.normalize().plan.notesRequestEffect).toBe("unresolved");
  });
  it("does not take a raw write-looking field from an inactive evaluator", async () => {
    const f = await producer("mutation_requested", false);
    expect(f.normalize().plan.notesRequestEffect).toBeUndefined();
  });
  it.each(["unhandled", "inactive", "parse-error", "handler-error"])("rejects a %s trace at the owned producer", async mode => {
    const f = await producer("mutation_requested");
    const run = { ...f.fieldRun, traces: f.fieldRun.traces.map(trace => ({ ...trace,
      ...(mode === "unhandled" ? { handled: false } : {}),
      ...(mode === "inactive" ? { active: false } : {}),
      ...(mode === "parse-error" ? { parseOutcome: "hard-fail" as const } : {}),
      ...(mode === "handler-error" ? { errorMessage: "controlled failure" } : {}),
    })) };
    expect(f.normalize(run.parsed, run).plan.notesRequestEffect).toBeUndefined();
  });
  it("does not substitute a different result value for the same-call parsed classification", async () => {
    const f = await producer("read_only");
    expect(f.normalize({ ...f.fieldRun.parsed, notesRequestEffect: "mutation_requested" }).plan.notesRequestEffect).toBeUndefined();
  });
});
