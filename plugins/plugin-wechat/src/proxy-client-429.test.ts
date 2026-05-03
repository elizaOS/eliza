import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("proxy-client 429 body consumption", () => {
  it("consumes response body before retry on 429", () => {
    const source = readFileSync(
      path.join(__dirname, "proxy-client.ts"),
      "utf-8",
    );

    const idx = source.indexOf("res.status === 429");
    expect(idx).toBeGreaterThan(-1);

    const block = source.slice(idx, idx + 500);
    expect(block).toContain("res.text()");
    expect(block.indexOf("res.text()")).toBeLessThan(
      block.indexOf("continue;"),
    );
  });
});
