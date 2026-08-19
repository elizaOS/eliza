/**
 * Isolated proof of the FormControl.fields graph budget. Origin recursed
 * without depth, visit, or cycle limits (20k nest → RangeError). This file
 * imports the production helper only.
 */

import { describe, expect, it } from "vitest";
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

  it("accepts a shared child that is not an ancestor cycle", () => {
    const shared = { key: "shared", label: "shared", type: "text" };
    const root = {
      key: "root",
      label: "root",
      type: "text",
      fields: [
        { key: "left", label: "left", type: "text", fields: [shared] },
        { key: "right", label: "right", type: "text", fields: [shared] },
      ],
    };

    expect(() => assertFormControlGraph(root)).not.toThrow();
  });

  it("charges sparse field slots before walking them", () => {
    const exact = new Array(MAX_FORM_CONTROL_NODES - 1);
    expect(() =>
      assertFormControlGraph({
        key: "root",
        label: "root",
        type: "text",
        fields: exact,
      }),
    ).not.toThrow();

    const oversized = new Array(MAX_FORM_CONTROL_NODES);
    expect(() =>
      assertFormControlGraph({
        key: "root",
        label: "root",
        type: "text",
        fields: oversized,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "FORM_CONTROL_UNBOUNDED",
        context: expect.objectContaining({
          visits: MAX_FORM_CONTROL_NODES + 1,
        }),
      }),
    );
  });

  it("charges sparse option and extraction-hint slots", () => {
    for (const property of ["options", "extractHints"] as const) {
      const control = {
        key: "root",
        label: "root",
        type: "text",
        [property]: new Array(MAX_FORM_CONTROL_NODES),
      };
      expect(() => assertFormControlGraph(control)).toThrow(
        expect.objectContaining({
          code: "FORM_CONTROL_UNBOUNDED",
          context: expect.objectContaining({
            visits: MAX_FORM_CONTROL_NODES + 1,
          }),
        }),
      );
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
