import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const read = (path) => readFileSync(join(root, path), "utf8");

describe("Capacitor frontend shell", () => {
  test("mounts the Vite app into the expected root", () => {
    expect(read("index.html")).toContain('<div id="root"></div>');
    expect(read("src/main.tsx")).toContain('document.getElementById("root")');
  });

  test("uses HTTP backend calls and provider-mode controls", () => {
    const app = read("src/App.tsx");
    const api = read("src/api.ts");

    expect(app).toContain("VITE_CHAT_BACKEND_URL");
    expect(app).toContain("Backend not reachable");
    expect(app).toContain("sendChat(config, text)");
    expect(app).toContain("getModeLabel(effectiveMode)");
    expect(api).toContain('"/greeting"');
    expect(api).toContain('"/history"');
    expect(api).toContain('"/reset"');
    expect(api).toContain('"/chat"');
  });
});
