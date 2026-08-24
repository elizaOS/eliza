/**
 * Unit coverage for GenUI streamed-spec patching: add/replace/remove
 * application, JSON Pointer parsing and escaping, per-operation failure
 * reporting, input immutability, and post-patch revalidation. Pure unit
 * harness driving the real module — no mocks and no renderer.
 */
import { describe, expect, it } from "vitest";
import {
  abortElizaGenUiStream,
  applyElizaGenUiPatch,
  resetElizaGenUiSpec,
} from "./streaming";
import type {
  ElizaGenUiComponent,
  ElizaGenUiPatchResult,
  ElizaGenUiSpec,
} from "./types";

function textComponent(id: string): ElizaGenUiComponent {
  return { id, component: "Text" };
}

function baseSpec(): ElizaGenUiSpec {
  return {
    version: "0.1",
    root: "root",
    components: [
      { id: "root", component: "Column", children: ["title"] },
      textComponent("title"),
    ],
    data: { count: 1, items: ["a", "b"] },
  };
}

function expectPatchOk(result: ElizaGenUiPatchResult): ElizaGenUiSpec {
  if (!result.ok) {
    throw new Error(`expected ok, got ${JSON.stringify(result.errors)}`);
  }
  return result.spec;
}

function expectPatchErrors(result: ElizaGenUiPatchResult) {
  if (result.ok) {
    throw new Error("expected patch application to fail");
  }
  return result.errors;
}

describe("applyElizaGenUiPatch", () => {
  it("returns a fresh deep clone for an empty patch list", () => {
    const spec = baseSpec();
    const out = expectPatchOk(applyElizaGenUiPatch(spec, []));
    expect(out).toEqual(spec);
    expect(out).not.toBe(spec);
    expect(out.data).not.toBe(spec.data);
    expect(out.components).not.toBe(spec.components);
  });

  it("adds a new key under data", () => {
    const out = expectPatchOk(
      applyElizaGenUiPatch(baseSpec(), [
        { op: "add", path: "/data/label", value: "hello" },
      ]),
    );
    expect(out.data?.label).toBe("hello");
  });

  it("replaces an existing key under data", () => {
    const out = expectPatchOk(
      applyElizaGenUiPatch(baseSpec(), [
        { op: "replace", path: "/data/count", value: 7 },
      ]),
    );
    expect(out.data?.count).toBe(7);
  });

  it("removes an existing key under data", () => {
    const out = expectPatchOk(
      applyElizaGenUiPatch(baseSpec(), [{ op: "remove", path: "/data/count" }]),
    );
    expect(Object.hasOwn(out.data ?? {}, "count")).toBe(false);
  });

  it("inserts at array indices and appends with the - token", () => {
    const out = expectPatchOk(
      applyElizaGenUiPatch(baseSpec(), [
        { op: "add", path: "/data/items/0", value: "z" },
        { op: "add", path: "/data/items/-", value: "c" },
      ]),
    );
    expect(out.data?.items).toEqual(["z", "a", "b", "c"]);
  });

  it("replaces an in-bounds array element", () => {
    const out = expectPatchOk(
      applyElizaGenUiPatch(baseSpec(), [
        { op: "replace", path: "/data/items/1", value: "q" },
      ]),
    );
    expect(out.data?.items).toEqual(["a", "q"]);
  });

  it("removes an array element and shifts the tail left", () => {
    const out = expectPatchOk(
      applyElizaGenUiPatch(baseSpec(), [
        { op: "remove", path: "/data/items/0" },
      ]),
    );
    expect(out.data?.items).toEqual(["b"]);
  });

  it("decodes ~1 and ~0 escapes in pointer tokens", () => {
    const out = expectPatchOk(
      applyElizaGenUiPatch(baseSpec(), [
        { op: "add", path: "/data/a~1b~0c", value: true },
      ]),
    );
    expect(Object.hasOwn(out.data ?? {}, "a/b~c")).toBe(true);
  });

  it("collapses empty pointer segments while resolving", () => {
    const out = expectPatchOk(
      applyElizaGenUiPatch(baseSpec(), [
        { op: "add", path: "/data//extra", value: 5 },
      ]),
    );
    expect(out.data?.extra).toBe(5);
  });

  it("applies patches in order so later patches see earlier writes", () => {
    const out = expectPatchOk(
      applyElizaGenUiPatch(baseSpec(), [
        { op: "add", path: "/data/name", value: "x" },
        { op: "replace", path: "/data/name", value: "y" },
        { op: "remove", path: "/data/count" },
      ]),
    );
    expect(out.data).toEqual({ items: ["a", "b"], name: "y" });
  });

  it("rejects paths that are not JSON Pointers", () => {
    const errors = expectPatchErrors(
      applyElizaGenUiPatch(baseSpec(), [{ op: "remove", path: "data/count" }]),
    );
    expect(errors).toMatchObject([
      {
        code: "invalid_spec",
        path: "data/count",
        message: expect.stringContaining("must be a JSON Pointer"),
      },
    ]);
  });

  it("reports the root pointer as non-resolving", () => {
    const errors = expectPatchErrors(
      applyElizaGenUiPatch(baseSpec(), [{ op: "add", path: "/", value: 1 }]),
    );
    expect(errors).toMatchObject([
      {
        code: "invalid_spec",
        path: "/",
        message: expect.stringContaining("does not resolve"),
      },
    ]);
  });

  it("fails when the final container is a primitive", () => {
    const errors = expectPatchErrors(
      applyElizaGenUiPatch(baseSpec(), [
        { op: "add", path: "/data/count/nested", value: 1 },
      ]),
    );
    expect(errors).toMatchObject([
      {
        code: "invalid_spec",
        path: "/data/count/nested",
        message: expect.stringContaining('failed at "/data/count/nested"'),
      },
    ]);
  });

  it("fails replacing a missing object key", () => {
    const errors = expectPatchErrors(
      applyElizaGenUiPatch(baseSpec(), [
        { op: "replace", path: "/data/nope", value: 1 },
      ]),
    );
    expect(errors).toMatchObject([
      { code: "invalid_spec", path: "/data/nope" },
    ]);
  });

  it("fails removing a missing object key", () => {
    const errors = expectPatchErrors(
      applyElizaGenUiPatch(baseSpec(), [{ op: "remove", path: "/data/nope" }]),
    );
    expect(errors).toMatchObject([
      { code: "invalid_spec", path: "/data/nope" },
    ]);
  });

  it("fails adding without a value payload", () => {
    const errors = expectPatchErrors(
      applyElizaGenUiPatch(baseSpec(), [{ op: "add", path: "/data/nope" }]),
    );
    expect(errors).toMatchObject([
      { code: "invalid_spec", path: "/data/nope" },
    ]);
  });

  it("rejects out-of-bounds array replacement", () => {
    const errors = expectPatchErrors(
      applyElizaGenUiPatch(baseSpec(), [
        { op: "replace", path: "/data/items/5", value: "q" },
      ]),
    );
    expect(errors).toMatchObject([
      { code: "invalid_spec", path: "/data/items/5" },
    ]);
  });

  it("rejects array insertion past the append position", () => {
    const errors = expectPatchErrors(
      applyElizaGenUiPatch(baseSpec(), [
        { op: "add", path: "/data/items/3", value: "gap" },
      ]),
    );
    expect(errors).toMatchObject([
      { code: "invalid_spec", path: "/data/items/3" },
    ]);
  });

  it("rejects negative array indices", () => {
    const errors = expectPatchErrors(
      applyElizaGenUiPatch(baseSpec(), [
        { op: "add", path: "/data/items/-1", value: "x" },
      ]),
    );
    expect(errors).toMatchObject([
      { code: "invalid_spec", path: "/data/items/-1" },
    ]);
  });

  it("rejects removing past the end of an array", () => {
    const errors = expectPatchErrors(
      applyElizaGenUiPatch(baseSpec(), [
        { op: "remove", path: "/data/items/2" },
      ]),
    );
    expect(errors).toMatchObject([
      { code: "invalid_spec", path: "/data/items/2" },
    ]);
  });

  it("rejects non-numeric array indices", () => {
    const errors = expectPatchErrors(
      applyElizaGenUiPatch(baseSpec(), [
        { op: "replace", path: "/data/items/abc", value: "x" },
      ]),
    );
    expect(errors).toMatchObject([
      { code: "invalid_spec", path: "/data/items/abc" },
    ]);
  });

  it("leaves the input spec untouched when any patch fails", () => {
    const spec = baseSpec();
    const result = applyElizaGenUiPatch(spec, [
      { op: "add", path: "/data/progress", value: "half" },
      { op: "replace", path: "/data/nope", value: 1 },
    ]);
    const errors = expectPatchErrors(result);
    expect(errors).toMatchObject([
      { code: "invalid_spec", path: "/data/nope" },
    ]);
    expect("spec" in result).toBe(false);
    expect(Object.hasOwn(spec.data ?? {}, "progress")).toBe(false);
    expect(spec).toEqual(baseSpec());
  });

  it("defers to spec validation when a patch breaks the header", () => {
    const errors = expectPatchErrors(
      applyElizaGenUiPatch(baseSpec(), [
        { op: "replace", path: "/version", value: "9.9" },
      ]),
    );
    expect(errors).toMatchObject([
      { code: "invalid_version", path: "version" },
    ]);
  });

  it("validates patched-in components against the catalog", () => {
    const errors = expectPatchErrors(
      applyElizaGenUiPatch(baseSpec(), [
        {
          op: "add",
          path: "/components/-",
          value: { id: "mystery", component: "Widget" },
        },
      ]),
    );
    expect(errors.some((issue) => issue.code === "unknown_component")).toBe(
      true,
    );
  });

  it("forwards validation options such as maxComponents", () => {
    const errors = expectPatchErrors(
      applyElizaGenUiPatch(
        baseSpec(),
        [
          {
            op: "add",
            path: "/components/-",
            value: { id: "third", component: "Text" },
          },
        ],
        { maxComponents: 2 },
      ),
    );
    expect(errors.some((issue) => issue.code === "too_many_components")).toBe(
      true,
    );
  });
});

describe("resetElizaGenUiSpec", () => {
  it("returns an independent deep clone", () => {
    const spec = baseSpec();
    const reset = resetElizaGenUiSpec(spec);
    expect(reset).toEqual(spec);
    expect(reset).not.toBe(spec);
    expect(reset.data).not.toBe(spec.data);
    if (reset.data) {
      reset.data.count = 99;
    }
    expect(spec.data?.count).toBe(1);
  });
});

describe("abortElizaGenUiStream", () => {
  it("wraps the reason as a single invalid_spec issue", () => {
    const result = abortElizaGenUiStream("user cancelled the stream");
    if (result.ok) {
      throw new Error("expected an aborted stream to be unsuccessful");
    }
    expect(result.errors).toMatchObject([
      { code: "invalid_spec", message: "user cancelled the stream" },
    ]);
    expect(
      result.errors.every(
        (issue) => issue.path === undefined && issue.componentId === undefined,
      ),
    ).toBe(true);
  });
});
