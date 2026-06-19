import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const read = (path) => readFileSync(join(root, path), "utf8");

describe("Elizagotchi example shell", () => {
  test("mounts the Vite app into the expected root", () => {
    expect(read("index.html")).toContain('<div id="root"></div>');
    expect(read("src/main.tsx")).toContain('document.getElementById("root")');
  });

  test("wires UI actions through the local agent command API", () => {
    const app = read("src/App.tsx");

    expect(app).toContain('import("./game/agent")');
    expect(app).toContain("subscribeElizagotchiState");
    expect(app).toContain("sendElizagotchiCommand(action)");
    expect(app).toContain('sendElizagotchiCommand("__tick__")');
    expect(app).toContain("`__reset__:");
    expect(app).toContain("encodeURIComponent(name)");
    expect(app).toContain('sendElizagotchiCommand("__export__")');
  });
});
