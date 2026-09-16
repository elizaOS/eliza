/** Complete recorded text and structured values survive the reader projection. */
import { describe, expect, it } from "vitest";
import type { TrajectoryLlmCall } from "../../api/client-types-cloud";
import {
  buildTrajectoryReaderData,
  splitTrajectoryReaderText,
  trajectoryCallStageLabel,
} from "./trajectory-reader-data";

function call(fields: Record<string, unknown>): TrajectoryLlmCall {
  return fields as unknown as TrajectoryLlmCall;
}

describe("trajectory reader data", () => {
  it.each([
    "",
    " \t\r\n",
    "preamble\r\n# First\r\n  text  \n\n## Second\rbody\n",
    "# Repeated\nfirst\n# Repeated\nsecond",
    "\uFEFF# Unicode 🦉\n漢字\u0000\ud800 and no final newline",
  ])("reconstructs all original text and offsets for %j", (text) => {
    const parts = splitTrajectoryReaderText(text);
    expect(parts.map((part) => part.text).join("")).toBe(text);
    expect(parts[0].start).toBe(0);
    expect(parts.at(-1)?.end).toBe(text.length);
    for (const [index, part] of parts.entries()) {
      expect(text.slice(part.start, part.end)).toBe(part.text);
      if (index > 0) expect(part.start).toBe(parts[index - 1].end);
    }
  });

  it("uses headings for labels without splitting code fences or changing bytes", () => {
    const text =
      "intro\r\n# Real\n```md\n# In code\n```\n~~~\n## Also code\n~~~~\n## Last\n";
    const parts = splitTrajectoryReaderText(text);
    expect(parts.map((part) => part.label)).toEqual(["Text", "Real", "Last"]);
    expect(parts.map((part) => part.text).join("")).toBe(text);
  });

  it("exposes standalone prompt labels while retaining exact source text", () => {
    const labels = [
      "provider:uiWidgetCapabilities:",
      "message_handler_stage:",
      "available_contexts:",
      "register_response_policy:",
      "navigation_reply:",
      "Routing:",
      "Reply:",
      "Instruction and secret boundaries:",
      "Domain routing (examples apply only when available, not a list to copy):",
      "Extraction:",
      "history_source_selection:",
    ];
    const text = `# Providers\r\nBefore labels.\n${labels
      .map((label, index) => `${label}\r\n  Original content ${index}.\n`)
      .join("")}## End\rLast text`;
    const parts = splitTrajectoryReaderText(text);
    expect(parts.map((part) => part.label)).toEqual([
      "Providers",
      ...labels.map((label) => label.slice(0, -1).replaceAll("_", " ")),
      "End",
    ]);
    expect(parts.map((part) => part.text).join("")).toBe(text);
    for (const [index, label] of labels.entries()) {
      const part = parts[index + 1];
      expect(part.text.startsWith(`${label}\r\n`)).toBe(true);
      expect(text.slice(part.start, part.end)).toBe(part.text);
    }
  });

  it("does not split inline labels, indented labels, URLs or fenced labels", () => {
    const text = [
      "message_handler_stage:",
      "current_turn_boundary: already has a value",
      "  nested_field:",
      "\tother_field:",
      "https://example.test/path:",
      "```text",
      "register_response_policy:",
      "# Fenced heading",
      "```",
      "~~~",
      "provider:NAME:",
      "~~~~",
      "Reply:",
      "Keep all of this.",
    ].join("\n");
    const parts = splitTrajectoryReaderText(text);
    expect(parts.map((part) => part.label)).toEqual([
      "message handler stage",
      "Reply",
    ]);
    expect(parts.map((part) => part.text).join("")).toBe(text);
  });

  it("distinguishes unavailable, empty and explicitly recorded values", () => {
    const absent = buildTrajectoryReaderData(call({}));
    expect(
      [...absent.input, ...absent.output].every(
        (s) => s.status === "unavailable",
      ),
    ).toBe(true);
    expect(absent.input[0].characterCount).toBeNull();
    const data = buildTrajectoryReaderData(
      call({
        systemPrompt: "",
        messages: [],
        tools: {},
        response: "",
        toolCalls: [],
        output: null,
        toolChoice: false,
        providerOptions: 0,
      }),
    );
    const all = [...data.input, ...data.output];
    for (const path of [
      "systemPrompt",
      "messages",
      "tools",
      "response",
      "toolCalls",
    ])
      expect(all.find((s) => s.sourcePath === path)?.status).toBe("empty");
    expect(
      all.find((s) => s.sourcePath === "systemPrompt")?.characterCount,
    ).toBe(0);
    expect(all.find((s) => s.sourcePath === "messages")?.text).toBe("[]");
    expect(all.find((s) => s.sourcePath === "tools")?.text).toBe("{}");
    for (const path of ["output", "toolChoice", "providerOptions"])
      expect(all.find((s) => s.sourcePath === path)?.status).toBe("recorded");
    expect(all.find((s) => s.sourcePath === "output")?.text).toBe("null");
    expect(
      buildTrajectoryReaderData(call({ systemPrompt: " \n" })).input[0].status,
    ).toBe("recorded");
  });

  it("preserves every message role, text byte and recorded flattened alternative", () => {
    const messages = [
      { role: "user", content: "  # Request\r\nKeep all whitespace.\n" },
      { role: "assistant", content: "" },
      { role: "developer", content: "policy 🦉" },
    ];
    const data = buildTrajectoryReaderData(
      call({
        systemPrompt: "# System\nOriginal system.",
        messages,
        prompt: "flattened prompt",
        userPrompt: "distinct user prompt",
      }),
    );
    for (const [index, original] of messages.entries()) {
      const s = data.input.find((s) => s.sourcePath === `messages[${index}]`);
      expect(s?.role).toBe(original.role);
      expect(s?.text).toBe(original.content);
      expect(s?.parts.map((p) => p.text).join("")).toBe(original.content);
      expect(s?.rawValue).toBe(original);
      expect(s?.characterCount).toBe(original.content.length);
    }
    expect(data.input.find((s) => s.sourcePath === "prompt")?.text).toBe(
      "flattened prompt",
    );
    expect(data.input.find((s) => s.sourcePath === "userPrompt")?.text).toBe(
      "distinct user prompt",
    );
  });

  it("retains complete multimodal messages and extra envelope fields as JSON", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Look\nclosely" },
          {
            type: "image",
            image: "data:image/png;base64,AAA=",
            mimeType: "image/png",
          },
          {
            type: "audio",
            audio: "data:audio/wav;base64,BBB=",
            options: { rate: 24000 },
          },
        ],
      },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "c1", function: { name: "LOOK", arguments: '{"x": 0}' } },
        ],
      },
      {
        role: "tool",
        tool_call_id: "c1",
        content: { ok: false, values: [0, null, ""] },
      },
      {
        role: "future-role",
        content: "text",
        futureMetadata: { preserve: true },
      },
      { content: "role unavailable" },
      "legacy message string",
    ];
    const before = JSON.stringify(messages);
    const data = buildTrajectoryReaderData(call({ messages }));
    for (const [index, original] of messages.entries()) {
      const s = data.input.find((s) => s.sourcePath === `messages[${index}]`);
      expect(s?.rawValue).toBe(original);
      if (index < 4) expect(JSON.parse(s?.text ?? "")).toEqual(original);
    }
    expect(
      data.input.find((s) => s.sourcePath === "messages[4]")?.role,
    ).toBeUndefined();
    expect(data.input.find((s) => s.sourcePath === "messages[5]")?.text).toBe(
      "legacy message string",
    );
    expect(JSON.stringify(messages)).toBe(before);
  });

  it("retains tools, schemas, response, reasoning and all tool call arguments", () => {
    const fields = {
      tools: {
        HANDLE_RESPONSE: {
          inputSchema: {
            type: "object",
            properties: { complete: { type: "boolean" } },
          },
        },
      },
      responseSchema: { required: ["complete"] },
      toolChoice: { type: "tool", toolName: "HANDLE_RESPONSE" },
      providerOptions: { custom: { value: 0 } },
      response: '  {"complete": true}\r\n',
      output: { content: [{ type: "text", text: "full answer" }] },
      reasoning: "# Reason\nKeep the original.",
      toolCalls: [
        {
          toolCallId: "c1",
          toolName: "HANDLE_RESPONSE",
          input: { complete: true },
          rawArgs: ' {"complete":true} ',
        },
      ],
    };
    const data = buildTrajectoryReaderData(call(fields));
    for (const [path, value] of Object.entries(fields)) {
      const s = [...data.input, ...data.output].find(
        (s) => s.sourcePath === path,
      );
      expect(s?.rawValue).toBe(value);
      if (typeof value === "string") expect(s?.text).toBe(value);
      else expect(JSON.parse(s?.text ?? "")).toEqual(value);
    }
  });

  it("labels mirrored alternatives and formatted metadata without altering payloads", () => {
    const fields = {
      prompt: "full prompt\r\n",
      userPrompt: "message mirror\n",
      tools: { HANDLE_RESPONSE: { inputSchema: { type: "object" } } },
      responseSchema: { type: "object" },
      providerOptions: {
        promptSegments: [{ text: "full prompt\r\n", source: "system" }],
      },
    };
    const data = buildTrajectoryReaderData(call(fields));
    const byPath = (path: string) =>
      data.input.find((s) => s.sourcePath === path);
    for (const path of ["prompt", "userPrompt"])
      expect(byPath(path)?.representationNote).toBe(
        "Rendered alternative; may repeat system/messages. Not an additional input.",
      );
    for (const path of ["tools", "responseSchema"])
      expect(byPath(path)?.representationNote).toBe(
        "Character counts describe this formatted JSON display, not provider token allocation or wire bytes.",
      );
    expect(byPath("providerOptions")?.representationNote).toBe(
      "Recorded request options can include local accounting metadata; their presence does not mean every value was sent to the provider.",
    );
    for (const [path, original] of Object.entries(fields)) {
      const s = byPath(path);
      expect(s?.rawValue).toBe(original);
      expect(s?.text).toBe(
        typeof original === "string"
          ? original
          : JSON.stringify(original, null, 2),
      );
      expect(s?.parts.map((part) => part.text).join("")).toBe(s?.text);
    }
  });

  it("keeps unknown message shapes and unavailable positions visible", () => {
    const message = { role: 7, content: "Keep the unusual role value." };
    const data = buildTrajectoryReaderData(
      call({ messages: [message, undefined, null] }),
    );
    const messages = data.input.filter((s) =>
      s.sourcePath.startsWith("messages["),
    );
    expect(messages).toHaveLength(3);
    expect(JSON.parse(messages[0].text)).toEqual(message);
    expect(messages[1].status).toBe("unavailable");
    expect(messages[2].text).toBe("null");
    expect(messages[2].status).toBe("recorded");
  });

  it("labels non-JSON values instead of silently dropping their fields", () => {
    const payload = {
      omittedInJson: undefined,
      integer: 1n,
      repeated: { x: 1 },
    };
    const data = buildTrajectoryReaderData(call({ tools: payload }));
    const tools = data.input.find((s) => s.sourcePath === "tools");
    expect(tools?.representationNote).toContain("Non-JSON");
    expect(tools?.text).toContain("omittedInJson");
    expect(tools?.text).toContain("bigint");
    expect(tools?.rawValue).toBe(payload);
  });

  it.each([
    [
      {
        modelType: "RESPONSE_HANDLER",
        systemPrompt: "evaluator_stage:\nCheck receipts.",
      },
      "Completion check",
    ],
    [{ modelType: "RESPONSE_HANDLER" }, "Response handler"],
    [{ purpose: "action_planner" }, "Action planner"],
    [{ stepType: "observation_extraction" }, "Memory extraction"],
    [
      { modelType: "TEXT_SMALL", userPrompt: "View catalog scope: {}" },
      "View resolver",
    ],
    [{ modelType: "TEXT_EMBEDDING" }, "Embedding"],
    [{ stepType: "evaluation" }, "Evaluation"],
    [{}, "Model call"],
  ])("labels the recorded call without claiming delivery", (fields, label) => {
    expect(trajectoryCallStageLabel(call(fields))).toBe(label);
  });
});
