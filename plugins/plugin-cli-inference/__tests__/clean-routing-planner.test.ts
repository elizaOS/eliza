/**
 * Contract pins for the clean-routing planner rewrite layer in
 * `src/clean-routing-planner.ts` (#29107).
 *
 * Imports the REAL production symbols — no implementation copy lives here —
 * and asserts the documented invariants that keep the CLI/Agent-SDK backends
 * routable: steering-role hygiene, `planner_stage:` grammar stripping, params
 * hygiene (no messages/tools passthrough), the `toolChoice: "required"`
 * live-info branch, param-hint rendering edges, TEXT-mode framing, and
 * ENVELOPE/ROUTE body composition. Deterministic node-only vitest; no CLI
 * process or live model.
 */

import type { ChatMessage, GenerateTextParams, ToolDefinition } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  appendTextDirective,
  buildCleanRoutingBody,
  buildCleanRoutingParams,
  buildCleanRoutingSystemPrompt,
  buildEnvelopeBody,
  buildRouterBody,
  frameTextSystemPrompt,
  TEXT_COMPLETION_DIRECTIVE,
  TEXT_COMPLETION_FRAMING,
} from "../src/clean-routing-planner";

const msg = (role: ChatMessage["role"], content: string | unknown): ChatMessage =>
  ({ role, content }) as unknown as ChatMessage;

const tool = (
  name: string,
  description: string,
  parameters?: ToolDefinition["parameters"]
): ToolDefinition => ({ name, description, parameters }) as unknown as ToolDefinition;

const baseParams = (overrides: Partial<GenerateTextParams> = {}): GenerateTextParams =>
  ({
    system: "You are Nova, a terse orbit analyst.",
    messages: [msg("user", "what's the weather on Mars")],
    tools: [
      tool("WEB_FETCH", "Fetch   a URL", {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      }),
    ],
    ...overrides,
  }) as unknown as GenerateTextParams;

/** The two reply rules are mutually exclusive branch markers. */
const LIVE_INFO_RULE = "This turn was flagged as needing a tool";
const REPLY_ALLOWED_RULE = "If you can answer the user directly";
/**
 * Substantive clauses of the required-tool branch — asserted independently of
 * the branch marker so a regression that keeps the marker but drops the
 * operational MUST/NEVER constraints still fails.
 */
const LIVE_INFO_MUST_CLAUSE = "you MUST choose the matching non-terminal action";
const LIVE_INFO_NEVER_CLAUSE = "do NOT choose REPLY/IGNORE/STOP for them";

describe("buildCleanRoutingParams — transcript hygiene", () => {
  it("drops system/developer steering messages and keeps user/assistant/tool turns in order", () => {
    const params = baseParams({
      messages: [
        msg("system", "DECODE RULES: emit <response> grammar"),
        msg("user", "what's the weather on Mars"),
        msg("assistant", "Let me check."),
        msg("tool", "temp: -63C"),
        msg("developer", "planner instructions"),
      ],
    });
    const prompt = buildCleanRoutingParams(params).prompt ?? "";
    expect(prompt).toContain("User: what's the weather on Mars");
    expect(prompt).toContain("Assistant: Let me check.");
    expect(prompt).toContain("Tool result: temp: -63C");
    // Steering content must not reach the CLI.
    expect(prompt).not.toContain("DECODE RULES");
    expect(prompt).not.toContain("planner instructions");
    // Order: user turn before assistant turn before tool turn.
    expect(prompt.indexOf("User: what's")).toBeLessThan(prompt.indexOf("Assistant: Let me check."));
    expect(prompt.indexOf("Assistant:")).toBeLessThan(prompt.indexOf("Tool result:"));
  });

  it("strips the injected planner_stage: grammar block from a user turn, keeping the real text", () => {
    const params = baseParams({
      messages: [
        msg("user", "what's the weather on Mars\n\nplanner_stage: pick tools <response>{...}"),
      ],
    });
    const prompt = buildCleanRoutingParams(params).prompt ?? "";
    expect(prompt).toContain("User: what's the weather on Mars");
    expect(prompt).not.toContain("planner_stage:");
    expect(prompt).not.toContain("<response>");
  });

  it("drops a user turn that is ONLY the planner_stage block (nothing real survives)", () => {
    const params = baseParams({
      messages: [msg("user", "planner_stage: grammar rules only")],
    });
    const prompt = buildCleanRoutingParams(params).prompt ?? "";
    expect(prompt).toContain("(no prior conversation)");
    expect(prompt).not.toContain("grammar rules only");
  });

  it("renders content-parts arrays through the canonical contentToText (tool calls/results survive)", () => {
    const parts = [
      { type: "text", text: "check this price" },
      { type: "tool-call", toolName: "WEB_FETCH", input: { url: "https://example.com/x" } },
      { type: "tool-result", toolName: "WEB_FETCH", output: { value: "59527" } },
    ];
    const prompt =
      buildCleanRoutingParams(baseParams({ messages: [msg("user", parts)] })).prompt ?? "";
    // The parts path feeds renderTranscript via the canonical contentToText —
    // this is the branch that decides whether real user text (and the fetched
    // data it produced) survives into the CLI prompt at all.
    expect(prompt).toContain("User: check this price");
    expect(prompt).toContain('[tool_call WEB_FETCH {"url":"https://example.com/x"}]');
    // toolOutputToText unwraps a {value} envelope to its inner string.
    expect(prompt).toContain("[tool_result WEB_FETCH: 59527]");
  });

  it("drops a user turn whose content-parts array yields no renderable text", () => {
    const prompt = buildCleanRoutingParams(
      baseParams({ messages: [msg("user", [{ type: "image", url: "file://x.png" }])] })
    );
    expect(prompt.prompt).toContain("(no prior conversation)");
  });

  it("renders an empty transcript as the explicit no-conversation placeholder", () => {
    const prompt = buildCleanRoutingParams(baseParams({ messages: [] })).prompt ?? "";
    expect(prompt).toContain("(no prior conversation)");
  });
});

describe("buildCleanRoutingParams — params hygiene (the flattenPrompt re-injection guard)", () => {
  it("returns params carrying ONLY system + prompt — no messages, no tools keys", () => {
    const out = buildCleanRoutingParams(baseParams());
    expect(out.system).toBeTypeOf("string");
    expect(out.prompt).toBeTypeOf("string");
    // flattenPrompt appends every non-system message to the body; carrying
    // messages/tools would re-inject the grammar block into the CLI call.
    expect(Object.keys(out).sort()).toEqual(["prompt", "system"]);
  });

  it("renders the action menu into the system prompt with param hints", () => {
    const { system } = buildCleanRoutingParams(baseParams());
    // Required param: no '?' flag. Description whitespace collapsed.
    expect(system).toContain("- WEB_FETCH — Fetch a URL [params: url: string]");
  });

  it("carries the persona into a voice block only when a system prompt exists", () => {
    const withVoice = buildCleanRoutingParams(baseParams());
    expect(withVoice.system).toContain("Your persona / voice");
    expect(withVoice.system).toContain("You are Nova, a terse orbit analyst.");

    const bare = buildCleanRoutingParams(baseParams({ system: undefined }));
    expect(bare.system).not.toContain("Your persona / voice");
  });
});

describe("buildCleanRoutingParams — toolChoice: required carry-through", () => {
  it("flips to the live-info MUST-tool rule when toolChoice is required", () => {
    const out = buildCleanRoutingParams(baseParams({ toolChoice: "required" }));
    expect(out.system).toContain(LIVE_INFO_RULE);
    expect(out.system).not.toContain(REPLY_ALLOWED_RULE);
    // The branch's operational contract, not just its marker: live/external
    // data MUST route to a non-terminal action and MUST NOT terminate.
    expect(out.system).toContain(LIVE_INFO_MUST_CLAUSE);
    expect(out.system).toContain(LIVE_INFO_NEVER_CLAUSE);
  });

  it("keeps the REPLY-allowed rule when toolChoice is auto/absent", () => {
    for (const toolChoice of [undefined, "auto"] as const) {
      const out = buildCleanRoutingParams(baseParams({ toolChoice }));
      expect(out.system).toContain(REPLY_ALLOWED_RULE);
      expect(out.system).not.toContain(LIVE_INFO_RULE);
    }
  });
});

describe("buildCleanRoutingSystemPrompt — branch and menu contract", () => {
  it("exposes exactly one of the two reply rules for each mustCallTool value", () => {
    const menu = "- WEB_FETCH — fetch [params: url: string]";
    const required = buildCleanRoutingSystemPrompt(menu, undefined, true);
    const optional = buildCleanRoutingSystemPrompt(menu, undefined, false);
    expect(required.includes(LIVE_INFO_RULE)).toBe(true);
    expect(required.includes(REPLY_ALLOWED_RULE)).toBe(false);
    expect(optional.includes(REPLY_ALLOWED_RULE)).toBe(true);
    expect(optional.includes(LIVE_INFO_RULE)).toBe(false);
    // Both branches keep the terminal action catalog and the JSON output shape.
    for (const prompt of [required, optional]) {
      expect(prompt).toContain("Terminal actions");
      expect(prompt).toContain('{"action": "<ACTION_NAME>", "params": { ... }}');
    }
  });

  it("defaults mustCallTool to false (omit = REPLY allowed)", () => {
    const prompt = buildCleanRoutingSystemPrompt("- A — do", undefined);
    expect(prompt).toContain(REPLY_ALLOWED_RULE);
  });
});

describe("buildRouterBody — ROUTE-mode body composition", () => {
  it("prefixes the persona, renders the menu, and closes with the route_action directive", () => {
    const body = buildRouterBody(baseParams());
    expect(body).toContain("Agent persona / voice (use it for any REPLY text):");
    expect(body).toContain("You are Nova, a terse orbit analyst.");
    expect(body).toContain("- WEB_FETCH — Fetch a URL [params: url: string]");
    expect(body).toContain("User: what's the weather on Mars");
    expect(body).toContain("Call route_action now for the single next action.");
    // The route_action directive must be the terminal suffix, not merely present.
    expect(body.endsWith("Call route_action now for the single next action.")).toBe(true);
  });

  it("falls back to the no-conversation placeholder and skips unnamed tools", () => {
    const body = buildRouterBody(
      baseParams({
        messages: [],
        tools: [
          { description: "no name" } as unknown as ToolDefinition,
          tool("NAMED", "has a name"),
        ],
      })
    );
    expect(body).toContain("(no prior conversation)");
    expect(body).toContain("- NAMED — has a name [params: (no params)]");
    expect(body).not.toContain("no name");
  });
});

describe("param hint rendering", () => {
  it("marks optional params with ?, renders enums, and handles missing schemas", () => {
    const params = baseParams({
      tools: [
        tool("SEARCH", "search things", {
          type: "object",
          properties: { q: { type: "string" }, mode: { type: "string", enum: ["fast", "deep"] } },
        }),
      ],
    });
    const { system } = buildCleanRoutingParams(params);
    expect(system).toContain("q?: string");
    expect(system).toContain('mode?: string one of ["fast", "deep"]');
  });

  it("falls back to the any type when a property carries no type", () => {
    const { system } = buildCleanRoutingParams(
      baseParams({
        tools: [
          tool("LOOKUP", "look things up", {
            type: "object",
            properties: { payload: { description: "no type key" } },
          }),
        ],
      })
    );
    expect(system).toContain("payload?: any");
    // The fallback must not fabricate a type that the schema did not state.
    expect(system).not.toContain("payload?: string");
    expect(system).not.toContain("payload?: object");
  });

  it("renders the (no params) hint for a non-object schema", () => {
    const { system } = buildCleanRoutingParams(
      baseParams({
        tools: [
          tool("BARE", "no schema at all"),
          tool("NULLY", "schema is null", null as unknown as ToolDefinition["parameters"]),
          // Truthy primitive: distinguishes the typeof guard from the falsy
          // `!schema` check, so deleting either half of the early return fails.
          tool("PRIM", "schema is a string", "nope" as unknown as ToolDefinition["parameters"]),
          // Non-object carrying an own `properties` field: without the typeof
          // guard this falls through to the properties lookup and would render
          // hints — the only input class where the two paths diverge.
          tool(
            "FN",
            "schema is a function",
            (() => {
              const fn = () => {};
              Object.defineProperty(fn, "properties", {
                value: { a: { type: "string" } },
                enumerable: true,
              });
              return fn as unknown as ToolDefinition["parameters"];
            })()
          ),
        ],
      })
    );
    expect(system).toContain("- BARE — no schema at all [params: (no params)]");
    expect(system).toContain("- NULLY — schema is null [params: (no params)]");
    expect(system).toContain("- PRIM — schema is a string [params: (no params)]");
    expect(system).toContain("- FN — schema is a function [params: (no params)]");
    // The typeof guard's observable contract: a non-object with an own
    // properties field renders no hints (does not read the field).
    expect(system).not.toContain("a?: string");
  });
});

describe("TEXT-mode framing", () => {
  it("prepends the completion framing BEFORE an existing system prompt", () => {
    const framed = frameTextSystemPrompt("persona: nova");
    expect(framed.startsWith(TEXT_COMPLETION_FRAMING)).toBe(true);
    expect(framed).toContain("persona: nova");
    // Framing must lead so the SDK model reads itself as a completion engine first.
    expect(framed.indexOf(TEXT_COMPLETION_FRAMING)).toBeLessThan(framed.indexOf("persona: nova"));
  });

  it("uses the framing alone when the system prompt is empty or whitespace", () => {
    expect(frameTextSystemPrompt(undefined)).toBe(TEXT_COMPLETION_FRAMING);
    expect(frameTextSystemPrompt("   ")).toBe(TEXT_COMPLETION_FRAMING);
  });

  it("keeps the framing substantive — the completion-engine contract clauses survive", () => {
    // Guards against a vacuous regression to an empty or gutted constant,
    // which the identity assertions above would silently pass.
    expect(TEXT_COMPLETION_FRAMING).toContain("text-generation engine");
    expect(TEXT_COMPLETION_FRAMING).toContain("never plan or call tools");
    expect(TEXT_COMPLETION_FRAMING.length).toBeGreaterThan(100);
    expect(TEXT_COMPLETION_DIRECTIVE).toContain("The FORMAT CONTRACT WINS");
    expect(TEXT_COMPLETION_DIRECTIVE).toContain("ALREADY executed");
    expect(TEXT_COMPLETION_DIRECTIVE).toContain("Never narrate");
    expect(TEXT_COMPLETION_DIRECTIVE.length).toBeGreaterThan(100);
  });

  it("appends the closing directive verbatim at the END of the body", () => {
    const out = appendTextDirective("body text");
    expect(out.startsWith("body text")).toBe(true);
    expect(out).toBe(`body text${TEXT_COMPLETION_DIRECTIVE}`);
    // The directive must be the terminal suffix, not merely present.
    expect(out.endsWith(TEXT_COMPLETION_DIRECTIVE)).toBe(true);
  });
});

describe("buildEnvelopeBody — ENVELOPE-mode body composition", () => {
  it("prefixes the trimmed system instructions and closes with the handle_response directive", () => {
    // Padded system input proves the trim, not just passthrough.
    const body = buildEnvelopeBody("  stage-1 rules  ", "conversation here");
    expect(body.startsWith("stage-1 rules")).toBe(true);
    expect(body).toContain("conversation here");
    // Full composition order: instructions → conversation → closing directive
    // as the actual suffix.
    const expected = `stage-1 rules

conversation here

---
Now call handle_response exactly once with the completed envelope fields.`;
    expect(body).toBe(expected);
  });

  it("omits the instruction prefix when system is empty", () => {
    const body = buildEnvelopeBody("  ", "conversation here");
    expect(body.startsWith("conversation here")).toBe(true);
  });
});

describe("buildCleanRoutingBody — transcript placeholder", () => {
  it("substitutes the placeholder for an empty transcript", () => {
    const body = buildCleanRoutingBody("");
    expect(body).toContain("(no prior conversation)");
    expect(body).not.toContain("\n\n\n");
  });

  it("embeds the transcript verbatim", () => {
    const body = buildCleanRoutingBody("User: hi");
    expect(body).toContain("Conversation so far:\nUser: hi");
  });
});
