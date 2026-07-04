import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const read = (path) => readFileSync(join(root, path), "utf8");

describe("Discord example package", () => {
  test("declares real package scripts without fake build or empty-test passes", () => {
    const pkg = JSON.parse(read("package.json"));

    expect(pkg.scripts.test).toBe("bun test smoke.test.js");
    expect(pkg.scripts.build).toBeUndefined();
    expect(pkg.scripts["lint:check"]).toBe("bunx @biomejs/biome check .");
    expect(pkg.scripts["format:check"]).toBe("bunx @biomejs/biome format .");
    expect(JSON.stringify(pkg.scripts)).not.toContain("passWithNoTests");
  });

  test("keeps the runnable agent wired to Discord handlers and plugins", () => {
    const agent = read("agent.ts");
    const handlers = read("handlers.ts");
    const character = read("character.ts");

    expect(agent).toContain("registerDiscordHandlers(runtime)");
    expect(agent).toContain("registerSlashCommands(runtime)");
    expect(agent).toContain("@elizaos/plugin-discord");
    expect(handlers).toContain("DISCORD_SLASH_COMMAND");
    expect(handlers).toContain("DISCORD_REGISTER_COMMANDS");
    expect(character).toContain("DiscordEliza");
  });
});
