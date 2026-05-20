import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const read = (path) => readFileSync(join(root, path), "utf8");

describe("Next.js example shell", () => {
  test("initializes the chat API before enabling the client", () => {
    const page = read("app/page.tsx");

    expect(page).toContain('"use client"');
    expect(page).toContain('fetch("/api/chat"');
    expect(page).toContain('JSON.stringify({ action: "init" })');
    expect(page).toContain("setIsInitialized(true)");
    expect(page).toContain('id="status-text"');
  });

  test("handles streaming data chunks from the chat route", () => {
    const page = read("app/page.tsx");

    expect(page).toContain("response.body?.getReader()");
    expect(page).toContain('line.startsWith("data: ")');
    expect(page).toContain("JSON.parse(line.slice(6))");
    expect(page).toContain("assistantMessageId");
  });
});
