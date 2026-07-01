import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const read = (path) => readFileSync(join(root, path), "utf8");

describe("React example shell", () => {
  test("mounts the Vite app into the expected root", () => {
    expect(read("index.html")).toContain('<div id="root"></div>');
    expect(read("src/main.tsx")).toContain('document.getElementById("root")');
  });

  test("keeps runtime loading lazy and provider-backed", () => {
    const app = read("src/App.tsx");

    expect(app).toContain('import("./eliza-runtime")');
    expect(app).toContain("getRuntime()");
    expect(app).toContain("getGreeting()");
    expect(app).toContain("getProviderName()");
    expect(app).toContain("sendMessage(text)");
    expect(app).toContain("PGlite (in-browser WASM Postgres)");
  });

  test("selects an LLM provider from env with no offline fallback", () => {
    const runtime = read("src/eliza-runtime.ts");

    expect(runtime).toContain("selectInferenceProvider");
    expect(runtime).toContain("@elizaos/plugin-openai");
    expect(runtime).toContain("@elizaos/plugin-openrouter");
    expect(runtime).toContain("@elizaos/plugin-anthropic");
    expect(runtime).toContain("@elizaos/plugin-elizacloud");
    expect(runtime).toContain("No inference provider configured");
  });
});
