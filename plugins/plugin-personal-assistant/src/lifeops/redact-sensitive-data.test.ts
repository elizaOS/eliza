/**
 * Pins the reference handling of the lifeops redaction walker: a shared object
 * must be redacted in full at every site, and only a reference back to an open
 * ancestor may collapse to "[Circular]". Deterministic; no mocks.
 */

import { describe, expect, it } from "vitest";
import { redactSensitiveData } from "./redact-sensitive-data.ts";

describe("redactSensitiveData reference handling", () => {
  it("redacts a shared (non-cyclic) reference in full at every site", () => {
    const shared = { note: "plain text" };
    expect(
      redactSensitiveData({ a: shared, b: shared, list: [shared, shared] }),
    ).toEqual({
      a: { note: "plain text" },
      b: { note: "plain text" },
      list: [{ note: "plain text" }, { note: "plain text" }],
    });
  });

  it("still collapses a true cycle to [Circular] and redacts its siblings", () => {
    const root: Record<string, unknown> = { note: "root" };
    root.self = root;
    root.child = { parent: root, note: "child" };
    expect(redactSensitiveData(root)).toEqual({
      note: "root",
      self: "[Circular]",
      child: { parent: "[Circular]", note: "child" },
    });
  });
});
