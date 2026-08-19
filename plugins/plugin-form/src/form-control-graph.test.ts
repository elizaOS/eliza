/**
 * Isolated proof of the FormControl.fields graph budget. Origin recursed
 * without depth, visit, or cycle limits (20k nest → RangeError). This file
 * imports the production helper only.
 */

import { describe, expect, it } from "bun:test";
import {
  assertFormControlGraph,
  FormControlGraphError,
  MAX_FORM_CONTROL_DEPTH,
  MAX_FORM_CONTROL_NODES,
} from "./form-control-graph.ts";
import { resolveControlTemplates } from "./template.ts";

function nest(depth: number): {
  key: string;
  label: string;
  type: string;
  fields?: unknown[];
} {
  let control: {
    key: string;
    label: string;
    type: string;
    fields?: unknown[];
  } = {
    key: "leaf",
    label: "ok",
    type: "text",
  };
  for (let i = 0; i < depth; i++) {
    control = {
      key: `n${i}`,
      label: "n",
      type: "text",
      fields: [control],
    };
  }
  return control;
}

describe("assertFormControlGraph", () => {
  it(`accepts nesting at the cap (${MAX_FORM_CONTROL_DEPTH})`, () => {
    expect(() =>
      assertFormControlGraph(nest(MAX_FORM_CONTROL_DEPTH)),
    ).not.toThrow();
  });

  it(`throws FORM_CONTROL_UNBOUNDED one past depth ${MAX_FORM_CONTROL_DEPTH}`, () => {
    try {
      assertFormControlGraph(nest(MAX_FORM_CONTROL_DEPTH + 1));
      throw new Error("expected FORM_CONTROL_UNBOUNDED");
    } catch (error) {
      expect(error).toBeInstanceOf(FormControlGraphError);
      expect((error as FormControlGraphError).code).toBe(
        "FORM_CONTROL_UNBOUNDED",
      );
      expect((error as Error).message).toMatch(/nesting exceeds 32/);
    }
  });

  it(`accepts ${MAX_FORM_CONTROL_NODES - 1} sibling fields`, () => {
    const fields = Array.from(
      { length: MAX_FORM_CONTROL_NODES - 1 },
      (_, i) => ({
        key: `k${i}`,
        label: "x",
        type: "text",
      }),
    );
    expect(() =>
      assertFormControlGraph({ key: "root", label: "r", type: "text", fields }),
    ).not.toThrow();
  });

  it(`throws FORM_CONTROL_UNBOUNDED at ${MAX_FORM_CONTROL_NODES} sibling fields`, () => {
    const fields = Array.from({ length: MAX_FORM_CONTROL_NODES }, (_, i) => ({
      key: `k${i}`,
      label: "x",
      type: "text",
    }));
    try {
      assertFormControlGraph({ key: "root", label: "r", type: "text", fields });
      throw new Error("expected FORM_CONTROL_UNBOUNDED");
    } catch (error) {
      expect(error).toBeInstanceOf(FormControlGraphError);
      expect((error as FormControlGraphError).code).toBe(
        "FORM_CONTROL_UNBOUNDED",
      );
      expect((error as Error).message).toMatch(/exceeds 2048 nodes/);
    }
  });

  it("throws FORM_CONTROL_UNBOUNDED on a cycle", () => {
    const cyclic: {
      key: string;
      label: string;
      type: string;
      fields: unknown[];
    } = {
      key: "a",
      label: "a",
      type: "text",
      fields: [],
    };
    cyclic.fields.push(cyclic);
    try {
      assertFormControlGraph(cyclic);
      throw new Error("expected FORM_CONTROL_UNBOUNDED");
    } catch (error) {
      expect(error).toBeInstanceOf(FormControlGraphError);
      expect((error as FormControlGraphError).message).toMatch(/cycle/);
    }
  });
});

describe("resolveControlTemplates", () => {
  it("still interpolates an honest nested control", () => {
    const resolved = resolveControlTemplates(
      {
        key: "delivery",
        label: "Delivery for {{name}}",
        type: "text",
        fields: [{ key: "sub", label: "Sub for {{name}}", type: "text" }],
      },
      { name: "Alice" },
    );
    expect(resolved.label).toBe("Delivery for Alice");
    expect(resolved.fields?.[0].label).toBe("Sub for Alice");
  });

  it("fails closed on a 20k nest instead of RangeError", () => {
    try {
      resolveControlTemplates(nest(20_000) as never, {});
      throw new Error("expected FORM_CONTROL_UNBOUNDED");
    } catch (error) {
      expect(error).toBeInstanceOf(FormControlGraphError);
      expect((error as Error).name).not.toBe("RangeError");
    }
  });
});
