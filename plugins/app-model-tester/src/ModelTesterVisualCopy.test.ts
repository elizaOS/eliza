import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

describe("ModelTesterAppView visual copy", () => {
  it("does not render redundant header helper copy or paragraph metadata", () => {
    const source = readFileSync(
      resolve(here, "ModelTesterAppView.tsx"),
      "utf8",
    );

    expect(source).not.toContain("End-to-end Eliza-1 probes");
    expect(source).not.toContain("<p className=");
  });
});
