import { mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isInsideRoot, isPluginRelativePath, resolveContained } from "../spec/paths";

describe("plugin-relative paths", () => {
	it("requires a ./ prefix", () => {
		expect(isPluginRelativePath("./bin/server")).toBe(true);
		expect(isPluginRelativePath("data")).toBe(false);
		expect(isPluginRelativePath("../bin/server")).toBe(false);
		expect(isPluginRelativePath("./../etc/passwd")).toBe(false);
	});

	it("detects lexical containment", () => {
		expect(isInsideRoot("/plugins/demo", "/plugins/demo/bin/echo")).toBe(true);
		expect(isInsideRoot("/plugins/demo", "/plugins/demo")).toBe(true);
		expect(isInsideRoot("/plugins/demo", "/plugins/other")).toBe(false);
		expect(isInsideRoot("/plugins/demo", "/plugins/demo-extra")).toBe(false);
	});

	it("rejects a path that escapes via ..", async () => {
		const root = await mkdtemp(join(tmpdir(), "agent-plugins-paths-"));
		const result = await resolveContained(root, "../outside");
		expect(result.ok).toBe(false);
	});

	it("accepts a missing file whose path stays inside the root", async () => {
		const root = await mkdtemp(join(tmpdir(), "agent-plugins-paths-"));
		const resolvedRoot = await realpath(root);
		const result = await resolveContained(root, "./bin/echo");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(isInsideRoot(resolvedRoot, result.path)).toBe(true);
		}
	});

	it("rejects a symlink that escapes the plugin root", async () => {
		const root = await mkdtemp(join(tmpdir(), "agent-plugins-paths-"));
		const outside = await mkdtemp(join(tmpdir(), "agent-plugins-outside-"));
		await writeFile(join(outside, "secret"), "nope");
		await symlink(join(outside, "secret"), join(root, "escaped"));
		const result = await resolveContained(root, "./escaped");
		expect(result.ok).toBe(false);
	});
});
