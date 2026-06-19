import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

function readSource(fileName: string): string {
  return readFileSync(resolve(here, fileName), "utf8");
}

describe("WifiAppView visual copy", () => {
  it("keeps the Android WiFi overlay free of paragraph helper copy", () => {
    const source = readSource("WifiAppView.tsx");

    expect(source).not.toContain("<p className=");
  });
});
