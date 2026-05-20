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

  test("keeps runtime loading lazy and local-only", () => {
    const app = read("src/App.tsx");

    expect(app).toContain('import("./eliza-runtime")');
    expect(app).toContain("getRuntime()");
    expect(app).toContain("getGreeting()");
    expect(app).toContain("sendMessage(text)");
    expect(app).toContain("PGlite (in-browser WASM Postgres)");
    expect(app.replace(/\s+/g, " ")).toContain("No server required");
  });
});
