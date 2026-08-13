import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseManifestJson } from "../spec/manifest";
import { isValidPluginName } from "../spec/names";
import { PLUGIN_SCHEMA_1_0_0 } from "../types";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

async function readFixture(name: string): Promise<string> {
	const { readFile } = await import("node:fs/promises");
	return readFile(join(fixtures, name, "plugin.json"), "utf8");
}

describe("plugin name constraints", () => {
	it.each(["my-plugin", "acme.tools", "lint3r", "a"])(
		"accepts %s",
		(name) => {
			expect(isValidPluginName(name)).toBe(true);
		},
	);

	it.each(["My-Plugin", "-start", "has--double", "too.many..dots", ""])(
		"rejects %s",
		(name) => {
			expect(isValidPluginName(name)).toBe(false);
		},
	);
});

describe("parseManifestJson", () => {
	it("accepts a minimal manifest", async () => {
		const result = parseManifestJson(await readFixture("minimal"));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.manifest.name).toBe("minimal-plugin");
			expect(result.manifest.$schema).toBe(PLUGIN_SCHEMA_1_0_0);
			expect(result.warnings).toEqual([]);
		}
	});

	it("accepts a full manifest", async () => {
		const result = parseManifestJson(await readFixture("full"));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.manifest.version).toBe("1.2.0");
			expect(result.manifest.author?.email).toBe("author@example.com");
			expect(result.manifest.keywords).toEqual(["summarize", "example"]);
		}
	});

	it("rejects an invalid name", async () => {
		const result = parseManifestJson(await readFixture("bad-name"));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.join(" ")).toMatch(/name/i);
		}
	});

	it("reports and ignores unknown top-level fields", async () => {
		const result = parseManifestJson(await readFixture("unknown-field"));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.warnings.some((w) => w.includes("notARealField"))).toBe(
				true,
			);
			expect(result.manifest.name).toBe("unknown-field-plugin");
		}
	});

	it("rejects a missing $schema", async () => {
		const result = parseManifestJson(await readFixture("missing-schema"));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.join(" ")).toMatch(/\$schema/);
		}
	});

	it("rejects a non-object author", () => {
		const result = parseManifestJson(
			JSON.stringify({
				$schema: PLUGIN_SCHEMA_1_0_0,
				name: "ok-plugin",
				author: "not-an-object",
			}),
		);
		expect(result.ok).toBe(false);
	});

	it("rejects author extra fields", () => {
		const result = parseManifestJson(
			JSON.stringify({
				$schema: PLUGIN_SCHEMA_1_0_0,
				name: "ok-plugin",
				author: { name: "Ada", twitter: "@ada" },
			}),
		);
		expect(result.ok).toBe(false);
	});
});
