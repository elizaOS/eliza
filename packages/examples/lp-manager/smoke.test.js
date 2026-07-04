import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const read = (path) => readFileSync(join(root, path), "utf8");

describe("LP Manager example package", () => {
  test("declares real package scripts without fake build or empty-test passes", () => {
    const pkg = JSON.parse(read("package.json"));

    expect(pkg.scripts.test).toBe("bun test smoke.test.js");
    expect(pkg.scripts.build).toBeUndefined();
    expect(pkg.scripts["lint:check"]).toBe("bunx @biomejs/biome check .");
    expect(pkg.scripts["format:check"]).toBe("bunx @biomejs/biome format .");
    expect(JSON.stringify(pkg.scripts)).not.toContain("pass-with-no-tests");
  });

  test("keeps the agent entrypoint wired to monitoring and wallet services", () => {
    const agent = read("src/agent.ts");
    const service = read("src/services/LpMonitoringService.ts");
    const entrypoint = read("src/index.ts");

    expect(agent).toContain("class LpManagerAgent");
    expect(agent).toContain("LpMonitoringService.start");
    expect(agent).toContain("@elizaos/plugin-wallet");
    expect(service).toContain("class LpMonitoringService extends Service");
    expect(entrypoint).toContain(
      "export { LpManagerAgent, loadConfigFromEnv }",
    );
  });
});
