import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAgentPlugin } from "../spec/package";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("loadAgentPlugin", () => {
	it("loads a minimal plugin", async () => {
		const result = await loadAgentPlugin(join(fixtures, "minimal"));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.plugin.manifest.name).toBe("minimal-plugin");
			expect(result.plugin.skills).toEqual([]);
			expect(result.plugin.mcp.present).toBe(false);
			expect(result.plugin.mcp.servers).toEqual([]);
		}
	});

	it("loads skills and a contained stdio MCP server", async () => {
		const result = await loadAgentPlugin(join(fixtures, "full"));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.plugin.skills.map((s) => s.directoryName)).toEqual([
				"summarize",
			]);
			expect(result.plugin.mcp.present).toBe(true);
			expect(result.plugin.mcp.configValid).toBe(true);
			expect(result.plugin.mcp.servers).toHaveLength(1);
			expect(result.plugin.mcp.servers[0]?.name).toBe("echo");
			expect(result.plugin.mcp.servers[0]?.mappedConfig.type).toBe("stdio");
			if (result.plugin.mcp.servers[0]?.mappedConfig.type === "stdio") {
				expect(result.plugin.mcp.servers[0].mappedConfig.command).toContain(
					`${join("full", "bin", "echo")}`,
				);
				expect(result.plugin.mcp.servers[0].mappedConfig.cwd).toContain(
					join("full", "bin"),
				);
			}
		}
	});

	it("rejects a plugin with an invalid name", async () => {
		const result = await loadAgentPlugin(join(fixtures, "bad-name"));
		expect(result.ok).toBe(false);
	});

	it("loads a plugin with an unknown field and a warning", async () => {
		const result = await loadAgentPlugin(join(fixtures, "unknown-field"));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.plugin.warnings.some((w) => w.includes("notARealField"))).toBe(
				true,
			);
		}
	});

	it("keeps the plugin when an MCP server escapes, invalidating only that server", async () => {
		const result = await loadAgentPlugin(join(fixtures, "escape-mcp"));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.plugin.mcp.present).toBe(true);
			expect(result.plugin.mcp.configValid).toBe(true);
			expect(result.plugin.mcp.servers).toEqual([]);
			expect(result.plugin.mcp.invalidServers).toHaveLength(1);
			expect(result.plugin.mcp.invalidServers[0]?.name).toBe("escaped");
		}
	});

	it("rejects a plugin missing $schema", async () => {
		const result = await loadAgentPlugin(join(fixtures, "missing-schema"));
		expect(result.ok).toBe(false);
	});
});
