import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const read = (path) => readFileSync(join(root, path), "utf8");

describe("Capacitor backend package", () => {
  test("declares real package scripts without empty test or typecheck build aliases", () => {
    const pkg = JSON.parse(read("package.json"));

    expect(pkg.scripts.test).toBe("bun test smoke.test.js");
    expect(pkg.scripts.test).not.toContain("--passWithNoTests");
    expect(pkg.scripts.build).toContain("bun build src/server.ts");
    expect(pkg.scripts.build).not.toContain("typecheck");
    expect(pkg.scripts["lint:check"]).toContain("biome check");
    expect(pkg.scripts["format:check"]).toContain("biome format");
  });

  test("exposes the HTTP chat endpoints used by the Capacitor frontend", () => {
    const server = read("src/server.ts");

    expect(server).toContain('url === "/health"');
    expect(server).toContain('url === "/greeting"');
    expect(server).toContain('url === "/history"');
    expect(server).toContain('url === "/reset"');
    expect(server).toContain('url === "/chat"');
    expect(server).toContain("Missing 'text' in request body");
    expect(server).toContain("Access-Control-Allow-Origin");
  });
});
