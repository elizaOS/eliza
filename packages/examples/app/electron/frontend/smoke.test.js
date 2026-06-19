import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const read = (path) => readFileSync(join(root, path), "utf8");

describe("Electron renderer shell", () => {
  test("mounts the Vite app into the expected root", () => {
    expect(read("index.html")).toContain('<div id="root"></div>');
    expect(read("src/main.tsx")).toContain('document.getElementById("root")');
  });

  test("uses the preload bridge for all chat operations", () => {
    const app = read("src/App.tsx");

    expect(app).toContain("window.elizaChat.getHistory(config)");
    expect(app).toContain("window.elizaChat.getGreeting(config)");
    expect(app).toContain("window.elizaChat.sendMessage(config, text)");
    expect(app).toContain("window.elizaChat.reset(config)");
    expect(app).toContain("Main-process agent via IPC");
  });
});
