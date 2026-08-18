/**
 * In-memory skill-manifest builder and symlink-escape classification tests for
 * the security scanner. The builder cases prove byte lengths for text and
 * binary payloads so integrity checks do not confuse character count with UTF-8
 * size. The scanManifest cases pin the separator-aware boundary of the blocking
 * `symlink-escape` rule so sibling directories sharing a string prefix cannot
 * masquerade as internal symlinks. Synthetic cases cover POSIX and Windows
 * path syntax; a real-filesystem case covers POSIX backslashes and canonical
 * root resolution.
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanSkillDirectory } from ".";
import type { ManifestFileEntry } from "./manifest-scanner";
import {
	buildManifestEntriesFromMemory,
	scanManifest,
} from "./manifest-scanner";

describe("buildManifestEntriesFromMemory", () => {
	it("returns an empty manifest for no files", () => {
		expect(buildManifestEntriesFromMemory(new Map())).toEqual([]);
	});

	it("measures text size in UTF-8 bytes, not characters", () => {
		const files = new Map([
			["a.txt", { content: "hello", isText: true }], // 5 ASCII bytes
			["u.txt", { content: "café", isText: true }], // é = 2 bytes -> 5
			["e.txt", { content: "🎉", isText: true }], // 1 char, 4 bytes
		]);
		const size = Object.fromEntries(
			buildManifestEntriesFromMemory(files).map((e) => [
				e.relativePath,
				e.sizeBytes,
			]),
		);
		expect(size["a.txt"]).toBe(5);
		expect(size["u.txt"]).toBe(5);
		expect(size["e.txt"]).toBe(4);
	});

	it("uses byteLength for binary content and preserves the path", () => {
		const files = new Map([
			[
				"b.bin",
				{ content: new Uint8Array([1, 2, 3, 4, 5, 6, 7]), isText: false },
			],
		]);
		const [entry] = buildManifestEntriesFromMemory(files);
		expect(entry.sizeBytes).toBe(7);
		expect(entry.relativePath).toBe("b.bin");
	});

	it("marks every entry as a non-symlink", () => {
		const files = new Map([["x", { content: "y", isText: true }]]);
		expect(
			buildManifestEntriesFromMemory(files).every((e) => e.isSymlink === false),
		).toBe(true);
	});
});

describe("scanManifest symlink-escape boundary", () => {
	const SKILL_DIR = "/base/skills/myskill";

	function symlinkFinding(target: string, skillDir = SKILL_DIR) {
		const entries: ManifestFileEntry[] = [
			{ relativePath: "SKILL.md", sizeBytes: 10, isSymlink: false },
			{
				relativePath: "link",
				sizeBytes: 0,
				isSymlink: true,
				symlinkTarget: target,
			},
		];
		const finding = scanManifest(entries, skillDir).find((f) =>
			f.ruleId.startsWith("symlink-"),
		);
		if (!finding) throw new Error("expected a symlink finding");
		return finding;
	}

	it("blocks a sibling-prefix target that only shares a string prefix", () => {
		// Regression for #21213: /base/skills/myskill-evil resolves OUTSIDE
		// /base/skills/myskill despite the shared prefix and must not be treated
		// as internal.
		const finding = symlinkFinding("/base/skills/myskill-evil/secret.env");
		expect(finding.ruleId).toBe("symlink-escape");
		expect(finding.severity).toBe("critical");
	});

	it("blocks a target fully outside the skill directory", () => {
		const finding = symlinkFinding("/etc/passwd");
		expect(finding.ruleId).toBe("symlink-escape");
		expect(finding.severity).toBe("critical");
	});

	it("blocks a POSIX sibling whose name begins with a backslash", () => {
		const finding = symlinkFinding("/base/skills/myskill\\evil/secret.env");
		expect(finding.ruleId).toBe("symlink-escape");
		expect(finding.severity).toBe("critical");
	});

	it("fails closed when a symlink target cannot be resolved", () => {
		const entries: ManifestFileEntry[] = [
			{ relativePath: "SKILL.md", sizeBytes: 10, isSymlink: false },
			{ relativePath: "broken-link", sizeBytes: 0, isSymlink: true },
		];
		const finding = scanManifest(entries, SKILL_DIR).find(
			(candidate) => candidate.file === "broken-link",
		);
		expect(finding?.ruleId).toBe("symlink-escape");
		expect(finding?.severity).toBe("critical");
	});

	it("treats a genuinely nested target as an internal warning", () => {
		const finding = symlinkFinding("/base/skills/myskill/sub/x");
		expect(finding.ruleId).toBe("symlink-internal");
		expect(finding.severity).toBe("warn");
	});

	it("treats a target equal to the skill directory as internal", () => {
		const finding = symlinkFinding("/base/skills/myskill");
		expect(finding.ruleId).toBe("symlink-internal");
		expect(finding.severity).toBe("warn");
	});

	it("classifies identically when the skill dir carries a trailing slash", () => {
		expect(
			symlinkFinding(
				"/base/skills/myskill-evil/secret.env",
				"/base/skills/myskill/",
			).ruleId,
		).toBe("symlink-escape");
		expect(symlinkFinding("/etc/passwd", "/base/skills/myskill/").ruleId).toBe(
			"symlink-escape",
		);
		expect(
			symlinkFinding("/base/skills/myskill/sub/x", "/base/skills/myskill/")
				.ruleId,
		).toBe("symlink-internal");
	});

	it("uses Windows separators and case-insensitive path identity", () => {
		expect(
			symlinkFinding(
				"C:\\base\\skills\\myskill-evil\\secret.env",
				"C:\\base\\skills\\myskill",
			).ruleId,
		).toBe("symlink-escape");
		expect(
			symlinkFinding(
				"c:\\BASE\\skills\\myskill\\sub\\x",
				"C:\\base\\skills\\myskill",
			).ruleId,
		).toBe("symlink-internal");
	});

	it("blocks a real POSIX backslash sibling while allowing a real internal target", async () => {
		const root = await mkdtemp(join(tmpdir(), "manifest-containment-"));
		try {
			const skillDir = join(root, "skill");
			const internalDir = join(skillDir, "internal");
			const escapedDir = join(root, "skill\\outside");
			await mkdir(internalDir, { recursive: true });
			await mkdir(escapedDir);
			await writeFile(join(skillDir, "SKILL.md"), "# Test\n");
			await writeFile(join(internalDir, "inside.txt"), "inside");
			await writeFile(join(escapedDir, "outside.txt"), "outside");
			await symlink(
				join(internalDir, "inside.txt"),
				join(skillDir, "internal-link"),
			);
			await symlink(
				join(escapedDir, "outside.txt"),
				join(skillDir, "escape-link"),
			);

			const report = await scanSkillDirectory(skillDir);
			expect(
				report.manifestFindings.find(
					(finding) => finding.file === "internal-link",
				)?.ruleId,
			).toBe("symlink-internal");
			expect(
				report.manifestFindings.find(
					(finding) => finding.file === "escape-link",
				)?.ruleId,
			).toBe("symlink-escape");
			expect(report.status).toBe("blocked");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
