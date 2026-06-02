import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

function readSource(name: string): string {
  return readFileSync(resolve(here, name), "utf8");
}

describe("Steward visual copy", () => {
  it("keeps main Steward surfaces free of helper paragraph tags", () => {
    expect(readSource("StewardView.tsx")).not.toContain("<p className=");
    expect(readSource("ApprovalQueue.tsx")).not.toContain("<p className=");
  });
});
