import { describe, test, expect } from "bun:test";
import {
  setByDotPath,
  applyResolutions,
} from "../../src/lib/n8n-clarification";

describe("setByDotPath", () => {
  test("writes through a numeric array index (existing behavior)", () => {
    const obj: Record<string, unknown> = {
      nodes: [
        { name: "A", parameters: {} },
        { name: "B", parameters: {} },
      ],
    };
    setByDotPath(obj, "nodes[1].parameters.channelId", "C-123");
    expect((obj.nodes as any)[1].parameters.channelId).toBe("C-123");
    expect((obj.nodes as any)[0].parameters).toEqual({});
  });

  test("resolves a string array segment by entry .name (n8n nodes)", () => {
    const obj: Record<string, unknown> = {
      nodes: [
        { name: "Webhook", parameters: { path: "/in" } },
        { name: "Post to Slack", parameters: {} },
      ],
    };
    setByDotPath(obj, 'nodes["Post to Slack"].parameters.channelId', "C-42");
    expect((obj.nodes as any)[1].parameters.channelId).toBe("C-42");
    // Other nodes untouched
    expect((obj.nodes as any)[0].parameters.path).toBe("/in");
  });

  test("resolves a string array segment by entry .id when name does not match", () => {
    const obj: Record<string, unknown> = {
      nodes: [
        { id: "uuid-slack", name: "Post to Slack", parameters: {} },
      ],
    };
    setByDotPath(obj, 'nodes["uuid-slack"].parameters.channelId', "C-99");
    expect((obj.nodes as any)[0].parameters.channelId).toBe("C-99");
  });

  test("throws when string segment matches no element by name or id", () => {
    const obj: Record<string, unknown> = {
      nodes: [{ name: "Webhook", parameters: {} }],
    };
    expect(() =>
      setByDotPath(obj, 'nodes["Placeholder Notification"].parameters.x', "y"),
    ).toThrow(/did not match any element by name\/id/);
  });

  test("dot identifiers still work end-to-end", () => {
    const obj: Record<string, unknown> = { a: { b: { c: 1 } } };
    setByDotPath(obj, "a.b.c", 42);
    expect((obj.a as any).b.c).toBe(42);
  });

  test("refuses to overwrite an object with a non-object value (object case)", () => {
    // The LLM sometimes points paramPath at a parent scope. Without this
    // guard, the assignment silently replaces the parameters object with
    // a string and n8n rejects the deploy with `parameters must be object`.
    const obj: Record<string, unknown> = {
      nodes: [{ name: "Trigger", parameters: { existing: "field" } }],
    };
    expect(() =>
      setByDotPath(obj, 'nodes["Trigger"].parameters', "discord"),
    ).toThrow(/refusing to overwrite with non-object value/);
    // Original parameters object is untouched.
    expect((obj.nodes as any)[0].parameters).toEqual({ existing: "field" });
  });

  test("refuses to overwrite an object inside an array (array case)", () => {
    const obj: Record<string, unknown> = {
      items: [{ a: 1 }, { b: 2 }],
    };
    expect(() => setByDotPath(obj, "items.0", "string")).toThrow(
      /refusing to overwrite with non-object value/,
    );
  });

  test("allows replacing a primitive with another primitive", () => {
    const obj: Record<string, unknown> = {
      nodes: [{ name: "T", parameters: { hour: 9 } }],
    };
    setByDotPath(obj, 'nodes["T"].parameters.hour', 10);
    expect((obj.nodes as any)[0].parameters.hour).toBe(10);
  });

  test("allows replacing an object with another object", () => {
    const obj: Record<string, unknown> = {
      nodes: [{ name: "T", parameters: { old: "x" } }],
    };
    setByDotPath(obj, 'nodes["T"].parameters', { new: "y" });
    expect((obj.nodes as any)[0].parameters).toEqual({ new: "y" });
  });
});

describe("applyResolutions", () => {
  test("applies a name-keyed paramPath to the matching node", () => {
    const draft: Record<string, unknown> = {
      nodes: [
        { name: "Hourly Trigger", parameters: { rule: "everyHour" } },
        { name: "Notify", parameters: {} },
      ],
    };
    const result = applyResolutions(draft, [
      {
        paramPath: 'nodes["Notify"].parameters.channelId',
        value: "discord-channel-1",
      },
    ]);
    expect(result.ok).toBe(true);
    expect((draft.nodes as any)[1].parameters.channelId).toBe(
      "discord-channel-1",
    );
  });

  test("falls back to userNotes when paramPath references a non-existent node", () => {
    const draft: Record<string, unknown> = {
      nodes: [{ name: "Hourly Trigger", parameters: {} }],
    };
    const result = applyResolutions(draft, [
      {
        paramPath: 'nodes["Placeholder Notification"].parameters',
        value: "discord",
      },
    ]);
    // Resolution doesn't fail the batch — the user's answer is preserved.
    expect(result.ok).toBe(true);
    const meta = (draft as any)._meta;
    expect(meta).toBeDefined();
    expect(meta.userNotes).toEqual(["discord"]);
    // Workflow nodes untouched.
    expect((draft.nodes as any).length).toBe(1);
    expect((draft.nodes as any)[0].name).toBe("Hourly Trigger");
  });

  test("falls back to userNotes when paramPath points at a parent object scope", () => {
    // The exact LLM failure the user hit: clarification asked for a
    // notification channel but paramPath was `nodes["Trigger"].parameters`
    // — the parameters object itself, not a leaf field. Old behavior
    // overwrote parameters with the string "discord" and broke deploy.
    const draft: Record<string, unknown> = {
      nodes: [{ name: "Hourly Trigger", parameters: { mode: "everyHour" } }],
    };
    const result = applyResolutions(draft, [
      {
        paramPath: 'nodes["Hourly Trigger"].parameters',
        value: "discord",
      },
    ]);
    expect(result.ok).toBe(true);
    expect((draft as any)._meta.userNotes).toEqual(["discord"]);
    // The parameters object survives untouched.
    expect((draft.nodes as any)[0].parameters).toEqual({ mode: "everyHour" });
  });

  test("falls back to userNotes when paramPath descends into a non-object", () => {
    const draft: Record<string, unknown> = {
      nodes: [{ name: "X", parameters: "this is a string not an object" }],
    };
    const result = applyResolutions(draft, [
      {
        paramPath: 'nodes["X"].parameters.channelId',
        value: "C-1",
      },
    ]);
    expect(result.ok).toBe(true);
    expect((draft as any)._meta.userNotes).toEqual(["C-1"]);
  });

  test("empty paramPath stores answer as userNote (existing behavior)", () => {
    const draft: Record<string, unknown> = { nodes: [], connections: {} };
    const result = applyResolutions(draft, [
      { paramPath: "", value: "use email" },
    ]);
    expect(result.ok).toBe(true);
    expect((draft as any)._meta.userNotes).toEqual(["use email"]);
  });

  test("multiple resolutions can mix successful path writes and userNote fallbacks", () => {
    const draft: Record<string, unknown> = {
      nodes: [{ name: "Real Node", parameters: {} }],
    };
    const result = applyResolutions(draft, [
      {
        paramPath: 'nodes["Real Node"].parameters.target',
        value: "ok",
      },
      {
        paramPath: 'nodes["Imaginary Node"].parameters.target',
        value: "fallback",
      },
      { paramPath: "", value: "free-form note" },
    ]);
    expect(result.ok).toBe(true);
    expect((draft.nodes as any)[0].parameters.target).toBe("ok");
    expect((draft as any)._meta.userNotes).toEqual([
      "fallback",
      "free-form note",
    ]);
  });

  test("non-string value still rejects the batch (validation, not path failure)", () => {
    const draft: Record<string, unknown> = { nodes: [] };
    const result = applyResolutions(draft, [
      // @ts-expect-error — testing runtime guard
      { paramPath: "x", value: 42 },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("must be a string");
    }
  });
});
