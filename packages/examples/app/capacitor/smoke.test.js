import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const read = (path) => readFileSync(join(root, path), "utf8");

describe("Capacitor example workspace", () => {
  test("points Capacitor at the built frontend", () => {
    const config = read("capacitor.config.ts");

    expect(config).toContain('appId: "com.elizaos.example.chat"');
    expect(config).toContain('appName: "ElizaOS Chat"');
    expect(config).toContain('webDir: "frontend/dist"');
  });

  test("keeps parent scripts delegated to backend and frontend packages", () => {
    const pkg = JSON.parse(read("package.json"));

    expect(pkg.scripts["dev:backend"]).toContain("--cwd backend");
    expect(pkg.scripts["dev:frontend"]).toContain("--cwd frontend");
    expect(pkg.scripts["build:frontend"]).toContain("--cwd frontend");
    expect(pkg.scripts["cap:sync"]).toContain("cap sync");
  });
});
