import React from "react";
import TestRenderer from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — MessageContent uses useApp() and client internally
// ---------------------------------------------------------------------------

vi.mock("@elizaos/app-core/state", () => ({
  useApp: () => ({
    agentStatus: { agentName: "Eliza" },
    setState: vi.fn(),
  }),
  getVrmPreviewUrl: () => null,
}));

vi.mock("@elizaos/app-core/api", () => ({
  client: {
    getConfig: vi.fn(async () => ({})),
    getPluginList: vi.fn(async () => []),
  },
}));

import {
  compilePatches,
  findPatchRegions,
  looksLikePatch,
  MessageContent,
  normalizePluginId,
  tryParsePatch,
} from "../../src/components/MessageContent";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderText(text: string): string {
  let tree!: TestRenderer.ReactTestRenderer;
  TestRenderer.act(() => {
    tree = TestRenderer.create(
      React.createElement(MessageContent, {
        message: { id: "m1", role: "assistant", text, timestamp: 1 },
      }),
    );
  });

  // Collect all text content from the rendered tree
  function collectText(node: TestRenderer.ReactTestInstance): string {
    return node.children
      .map((child) =>
        typeof child === "string"
          ? child
          : collectText(child as TestRenderer.ReactTestInstance),
      )
      .join("");
  }

  return collectText(tree.root).trim();
}

// ---------------------------------------------------------------------------
// Tests — JSONL patch detection (the json-render renderer path)
// ---------------------------------------------------------------------------

describe("looksLikePatch", () => {
  it("matches compact JSON patch", () => {
    expect(looksLikePatch('{"op":"add","path":"/root","value":"x"}')).toBe(
      true,
    );
  });

  it("matches spaced JSON patch (Claude output style)", () => {
    expect(
      looksLikePatch('{ "op": "add", "path": "/root", "value": "x" }'),
    ).toBe(true);
  });

  it("rejects plain text", () => {
    expect(looksLikePatch("Hello world")).toBe(false);
  });

  it("rejects JSON without op field", () => {
    expect(looksLikePatch('{"type":"Card","props":{}}')).toBe(false);
  });

  it("rejects code fence lines", () => {
    expect(looksLikePatch("```json")).toBe(false);
    expect(looksLikePatch("```")).toBe(false);
  });
});

describe("tryParsePatch", () => {
  it("parses compact add patch", () => {
    const p = tryParsePatch('{"op":"add","path":"/root","value":"card-1"}');
    expect(p).not.toBeNull();
    expect(p?.op).toBe("add");
    expect(p?.path).toBe("/root");
  });

  it("parses spaced add patch", () => {
    const p = tryParsePatch(
      '{ "op": "add", "path": "/root", "value": "card-1" }',
    );
    expect(p).not.toBeNull();
    expect(p?.op).toBe("add");
    expect(p?.path).toBe("/root");
  });

  it("returns null for plain text", () => {
    expect(tryParsePatch("Sure, here is your form:")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(tryParsePatch('{"op":"add","path":"/root"')).toBeNull();
  });
});

describe("compilePatches", () => {
  it("builds a valid UiSpec from add patches", () => {
    const patches = [
      { op: "add" as const, path: "/root", value: "card-1" },
      {
        op: "add" as const,
        path: "/elements/card-1",
        value: { type: "Card", props: { title: "Test" }, children: [] },
      },
      { op: "add" as const, path: "/state/amount", value: 0 },
    ];
    const spec = compilePatches(patches);
    expect(spec).not.toBeNull();
    expect(spec?.root).toBe("card-1");
    expect(spec?.elements["card-1"]).toBeDefined();
    expect(spec?.state.amount).toBe(0);
  });

  it("returns null if /root is missing", () => {
    const patches = [
      {
        op: "add" as const,
        path: "/elements/card-1",
        value: { type: "Card", props: {}, children: [] },
      },
    ];
    expect(compilePatches(patches)).toBeNull();
  });

  it("ignores prototype-pollution path segments", () => {
    const patches = [
      { op: "add" as const, path: "/root", value: "card-1" },
      {
        op: "add" as const,
        path: "/elements/card-1",
        value: { type: "Card", props: { title: "Safe" }, children: [] },
      },
      {
        op: "add" as const,
        path: "/state/__proto__/polluted",
        value: true,
      },
      { op: "add" as const, path: "/state/amount", value: 42 },
    ];

    const spec = compilePatches(patches);
    expect(spec).not.toBeNull();
    expect(spec?.state.amount).toBe(42);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });
});

describe("findPatchRegions", () => {
  it("detects bare compact JSONL patches", () => {
    const text = [
      "Sure, here you go:",
      '{"op":"add","path":"/root","value":"card-1"}',
      '{"op":"add","path":"/elements/card-1","value":{"type":"Card","props":{"title":"Hi"},"children":[]}}',
      '{"op":"add","path":"/state","value":{}}',
    ].join("\n");
    const regions = findPatchRegions(text);
    expect(regions).toHaveLength(1);
    expect(regions[0].spec.root).toBe("card-1");
  });

  it("detects spaced JSONL patches (Claude output style)", () => {
    const text = [
      "Here is your dashboard:",
      '{ "op": "add", "path": "/root", "value": "card-1" }',
      '{ "op": "add", "path": "/elements/card-1", "value": { "type": "Card", "props": { "title": "Dashboard" }, "children": [] } }',
      '{ "op": "add", "path": "/state", "value": {} }',
    ].join("\n");
    const regions = findPatchRegions(text);
    expect(regions).toHaveLength(1);
    expect(regions[0].spec.root).toBe("card-1");
  });

  it("detects patches inside a code fence", () => {
    const text = [
      "Here is the UI:",
      "```json",
      '{"op":"add","path":"/root","value":"card-1"}',
      '{"op":"add","path":"/elements/card-1","value":{"type":"Card","props":{"title":"Fenced"},"children":[]}}',
      '{"op":"add","path":"/state","value":{}}',
      "```",
    ].join("\n");
    const regions = findPatchRegions(text);
    expect(regions).toHaveLength(1);
    expect(regions[0].spec.root).toBe("card-1");
  });

  it("returns empty array for plain text", () => {
    expect(findPatchRegions("Hello! How can I help you today?")).toHaveLength(
      0,
    );
  });

  it("returns empty array if /root patch is missing", () => {
    const text =
      '{"op":"add","path":"/elements/card-1","value":{"type":"Card","props":{},"children":[]}}';
    expect(findPatchRegions(text)).toHaveLength(0);
  });

  it("flushes before malformed patch-like text after an empty line", () => {
    const text = [
      '{"op":"add","path":"/root","value":"card-1"}',
      "",
      '{"op":"add","path":"/elements/card-1"',
      "hello",
    ].join("\n");

    const regions = findPatchRegions(text);
    expect(regions).toHaveLength(1);
    expect(regions[0]?.raw).toBe(
      '{"op":"add","path":"/root","value":"card-1"}',
    );
  });
});

describe("normalizePluginId", () => {
  it("strips the plugin package prefix", () => {
    expect(normalizePluginId("@elizaos/plugin-discord")).toBe("discord");
  });

  it("leaves plain plugin ids unchanged", () => {
    expect(normalizePluginId("discord")).toBe("discord");
  });

  it("leaves non-plugin scoped packages unchanged", () => {
    expect(normalizePluginId("@scope/not-plugin-name")).toBe(
      "@scope/not-plugin-name",
    );
  });
});

// ---------------------------------------------------------------------------
// Tests — XML stripping regression
// ---------------------------------------------------------------------------

describe("MessageContent — XML action stripping", () => {
  it("strips <actions> XML from message text", () => {
    const text =
      'Here is my response <actions><action name="DO_THING"><params>{"key":"val"}</params></action></actions>';
    const rendered = renderText(text);
    expect(rendered).toBe("Here is my response");
    expect(rendered).not.toContain("<actions>");
  });

  it("strips <params> XML from message text", () => {
    const text =
      'Some text <params>{"repo":"https://github.com/test"}</params>';
    const rendered = renderText(text);
    expect(rendered).toBe("Some text");
    expect(rendered).not.toContain("<params>");
  });

  it("renders empty for message containing only XML", () => {
    const text =
      '<actions><action name="START_CODING_TASK"><params>{"task":"fix bug"}</params></action></actions>';
    const rendered = renderText(text);
    expect(rendered).toBe("");
  });

  it("preserves message text with no XML", () => {
    const text = "Hello, how can I help you today?";
    const rendered = renderText(text);
    expect(rendered).toBe("Hello, how can I help you today?");
  });

  it("shows only the <text> portion of structured response XML", () => {
    const text =
      "<response><thought>internal chain</thought><text>Hello world</text></response>";
    const rendered = renderText(text);
    expect(rendered).toBe("Hello world");
    expect(rendered).not.toContain("internal chain");
  });

  it("shows partial streamed <text> content without leaking wrapper XML", () => {
    const text = "<response><thought>internal chain</thought><text>Hello world";
    const rendered = renderText(text);
    expect(rendered).toBe("Hello world");
    expect(rendered).not.toContain("<response>");
    expect(rendered).not.toContain("internal chain");
  });

  it("renders nothing until structured response text starts", () => {
    const text = "<response><thought>internal chain</thought>";
    const rendered = renderText(text);
    expect(rendered).toBe("");
  });

  it("strips analysis XML blocks from displayed text", () => {
    const text =
      "Visible text <analysis>do not show this planning output</analysis> after";
    const rendered = renderText(text);
    expect(rendered.replace(/\s+/g, " ").trim()).toBe("Visible text after");
    expect(rendered).not.toContain("planning output");
  });

  it("strips single-star stage directions from displayed assistant text", () => {
    const rendered = renderText("*waves warmly* Hello there.");
    expect(rendered).toBe("Hello there.");
  });

  it("preserves bold markdown-style text", () => {
    const rendered = renderText("**Saturday**: Sunny and warm.");
    expect(rendered).toBe("**Saturday**: Sunny and warm.");
  });
});

describe("XML tag stripping during streaming", () => {
  it("strips <actions> blocks completely", () => {
    const output = renderText(
      'Hello world<actions><action name="test">do thing</action></actions>',
    );
    expect(output).toContain("Hello world");
    expect(output).not.toContain("do thing");
    expect(output).not.toContain("<actions>");
  });

  it("strips <think> blocks completely", () => {
    const output = renderText(
      "<think>internal reasoning about the query</think>Hello there!",
    );
    expect(output).toContain("Hello there!");
    expect(output).not.toContain("internal reasoning");
    expect(output).not.toContain("<think>");
  });

  it("extracts text from <response><text> wrapper", () => {
    const output = renderText("<response><text>Hello world</text></response>");
    expect(output).toContain("Hello world");
    expect(output).not.toContain("<response>");
    expect(output).not.toContain("<text>");
  });

  it("handles partial <response><text> during streaming (no closing tag yet)", () => {
    const output = renderText("<response><text>Hello wor");
    expect(output).toContain("Hello wor");
  });

  it("does not leak <actions> tag name as visible text", () => {
    const output = renderText(
      'Answer here<actions><action name="save">data</action></actions> done',
    );
    expect(output).not.toContain("actions");
    expect(output).not.toContain("save");
  });
});
