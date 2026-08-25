/** Locks relationships empty states to available workspace height on short viewports. */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(import.meta.dirname, "RelationshipsWorkspaceView.tsx"),
  "utf8",
);

describe("RelationshipsWorkspaceView empty-state placement", () => {
  it("uses workspace placement instead of a desktop minimum height", () => {
    expect(source).not.toContain("min-h-[24rem]");
    expect(
      source.match(/variant=\{embedded \? "panel" : "workspace"\}/g),
    ).toHaveLength(2);
  });
});
