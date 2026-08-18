/**
 * Tests for skill zip extraction hardening — the sinks for W5-007 (zip-slip:
 * backslash, absolute, and `..` entry names escaping the skill directory on
 * extraction), its Windows residual (segments Win32 canonicalizes at write
 * time — trailing dots/spaces per component, colons, reserved device names),
 * and W5-031 (zip-bomb: uncompressed expansion previously bounded only by the
 * 10 MB compressed download cap). Uses real fflate-produced archives, a real
 * tmpdir-backed FileSystemSkillStore, and forged central-directory sizes. No
 * mocks beyond the shared @elizaos/core double.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	FileSystemSkillStore,
	MAX_ZIP_UNCOMPRESSED_SIZE,
	MemorySkillStore,
} from "./storage";

const encoder = new TextEncoder();

function makeZip(entries: Record<string, string>): Uint8Array {
	const input: Record<string, Uint8Array> = {};
	for (const [name, content] of Object.entries(entries)) {
		input[name] = strToU8(content);
	}
	return zipSync(input);
}

/**
 * Overwrite the uncompressed-size field of every central-directory entry,
 * simulating a zip whose declared sizes do not match its real payload.
 */
function forgeUncompressedSizes(zip: Uint8Array, size: number): Uint8Array {
	const out = new Uint8Array(zip);
	const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
	let eocd = -1;
	for (let i = out.length - 22; i >= 0; i--) {
		if (
			out[i] === 0x50 &&
			out[i + 1] === 0x4b &&
			out[i + 2] === 0x05 &&
			out[i + 3] === 0x06
		) {
			eocd = i;
			break;
		}
	}
	expect(eocd).toBeGreaterThanOrEqual(0);
	const entryCount = view.getUint16(eocd + 10, true);
	let offset = view.getUint32(eocd + 16, true);
	for (let i = 0; i < entryCount; i++) {
		expect(view.getUint32(offset, true)).toBe(0x02014b50);
		view.setUint32(offset + 24, size, true);
		offset +=
			46 +
			view.getUint16(offset + 28, true) +
			view.getUint16(offset + 30, true) +
			view.getUint16(offset + 32, true);
	}
	return out;
}

const traversalEntries: Array<[label: string, entryName: string]> = [
	["backslash traversal", "..\\..\\..\\escape.bat"],
	["forward-slash traversal", "../../../escape.txt"],
	["absolute POSIX path", "/etc/eliza-escape.txt"],
	["drive-letter path", "C:/Windows/eliza-escape.dll"],
	["drive-relative path", "C:eliza-escape.txt"],
	["mixed separators", "subdir\\../../escape.txt"],
	["backslash-only parent", "..\\escape.txt"],
];

// Win32 canonicalizes every path component at write time: trailing dots and
// spaces are stripped (`.. ` becomes `..`, `...` collapses to nothing), a
// colon addresses an NTFS alternate data stream, and reserved device stems
// resolve to devices rather than files. Each of these passes an exact-`..`
// check, so every class must be rejected by name validation.
const windowsCanonicalizationEntries: Array<[label: string, entryName: string]> =
	[
		["trailing-space parent segment", ".. /escape.txt"],
		["trailing-space parent segment mid-path", "sub/.. /escape.txt"],
		["parent segment with mixed trailing dots and spaces", "sub/.. ./escape.txt"],
		["parent segment with multiple trailing spaces", "sub/..  /escape.txt"],
		["dots-only segment", ".../escape.txt"],
		["dots-and-spaces-only segment", "sub/ . /escape.txt"],
		["space-only segment", "sub/ /escape.txt"],
		["trailing-dot file name", "escape.txt."],
		["trailing-space directory segment", "sub /escape.txt"],
		["NTFS alternate data stream", "escape.txt:payload"],
		["NTFS stream type on nested entry", "sub/escape.txt:$DATA"],
		["reserved device name CON", "CON"],
		["reserved device name with extension", "NUL.txt"],
		["lowercase reserved device stem", "nul.md"],
		["reserved device name as directory segment", "com1/escape.txt"],
		["reserved device name LPT", "lpt9/escape.txt"],
		["reserved device name COM with superscript digit", "COM¹.txt"],
		["reserved device name LPT with superscript digit", "lpt³/escape.txt"],
	];

describe("zip entry path validation", () => {
	let basePath: string;
	let fsStore: FileSystemSkillStore;
	let memStore: MemorySkillStore;

	beforeEach(async () => {
		basePath = fs.mkdtempSync(path.join(os.tmpdir(), "w6-skills-test-"));
		fsStore = new FileSystemSkillStore(basePath);
		await fsStore.initialize();
		memStore = new MemorySkillStore();
	});

	afterEach(() => {
		fs.rmSync(basePath, { recursive: true, force: true });
	});

	const stores = () => [
		{
			name: "FileSystemSkillStore.saveFromZip",
			extract: (zip: Uint8Array) => fsStore.saveFromZip("demo", zip),
		},
		{
			name: "MemorySkillStore.loadFromZip",
			extract: (zip: Uint8Array) => memStore.loadFromZip("demo", zip),
		},
	];

	for (const [label, entryName] of [
		...traversalEntries,
		...windowsCanonicalizationEntries,
	]) {
		it(`rejects ${label} entries in both stores`, async () => {
			const zip = makeZip({ "SKILL.md": "# demo", [entryName]: "payload" });
			for (const store of stores()) {
				await expect(store.extract(zip)).rejects.toMatchObject({
					code: "SKILL_ZIP_ENTRY_UNSAFE",
				});
			}
			// The rejection happens before any write: no skill directory, no
			// escaped file anywhere near the base path.
			expect(fs.existsSync(path.join(basePath, "demo"))).toBe(false);
			expect(fs.existsSync(path.join(basePath, "escape.txt"))).toBe(false);
			expect(memStore.getPackage("demo")).toBeUndefined();
		});
	}

	it("rejects an entry consisting only of a parent segment", async () => {
		const zip = makeZip({ "..": "payload", "SKILL.md": "# demo" });
		for (const store of stores()) {
			await expect(store.extract(zip)).rejects.toMatchObject({
				code: "SKILL_ZIP_ENTRY_UNSAFE",
			});
		}
	});

	it("installs a well-formed skill zip end to end", async () => {
		const zip = makeZip({
			"SKILL.md": "# demo skill",
			"scripts/run.sh": "echo hi",
			"references/doc.md": "docs",
		});
		await fsStore.saveFromZip("demo", zip);
		expect(fs.readFileSync(path.join(basePath, "demo", "SKILL.md"), "utf-8")).toBe(
			"# demo skill",
		);
		expect(
			fs.readFileSync(path.join(basePath, "demo", "scripts", "run.sh"), "utf-8"),
		).toBe("echo hi");
		expect(await fsStore.loadSkillContent("demo")).toBe("# demo skill");

		await memStore.loadFromZip("demo", zip);
		expect(await memStore.loadSkillContent("demo")).toBe("# demo skill");
		expect(await memStore.loadFile("demo", "scripts/run.sh")).toBe("echo hi");
	});

	it("keeps an existing installation intact when a replacement package is unsafe", async () => {
		await fsStore.saveFromZip(
			"demo",
			makeZip({ "SKILL.md": "# original", "original.txt": "keep" }),
		);

		await expect(
			fsStore.saveFromZip(
				"demo",
				makeZip({ "SKILL.md": "# replacement", "COM².txt": "unsafe" }),
			),
		).rejects.toMatchObject({ code: "SKILL_ZIP_ENTRY_UNSAFE" });

		expect(await fsStore.loadSkillContent("demo")).toBe("# original");
		expect(fs.readFileSync(path.join(basePath, "demo", "original.txt"), "utf-8")).toBe(
			"keep",
		);
	});

	it("atomically replaces the complete installed package", async () => {
		await fsStore.saveFromZip(
			"demo",
			makeZip({ "SKILL.md": "# original", "obsolete.txt": "old" }),
		);
		await fsStore.saveFromZip(
			"demo",
			makeZip({ "SKILL.md": "# replacement", "current.txt": "new" }),
		);

		expect(await fsStore.loadSkillContent("demo")).toBe("# replacement");
		expect(fs.existsSync(path.join(basePath, "demo", "obsolete.txt"))).toBe(false);
		expect(fs.readFileSync(path.join(basePath, "demo", "current.txt"), "utf-8")).toBe(
			"new",
		);
	});

	it("skips directory entries without rejecting the archive", async () => {
		const input: Record<string, Uint8Array> = {
			"SKILL.md": strToU8("# demo"),
			"scripts/": new Uint8Array(0),
			"scripts/run.sh": strToU8("echo hi"),
		};
		const zip = zipSync(input);
		await fsStore.saveFromZip("demo", zip);
		expect(
			fs.existsSync(path.join(basePath, "demo", "scripts", "run.sh")),
		).toBe(true);
	});

	it("keeps skipping conventional no-op segments", async () => {
		const zip = makeZip({ "./SKILL.md": "# demo" });
		await fsStore.saveFromZip("demo", zip);
		expect(await fsStore.loadSkillContent("demo")).toBe("# demo");
	});

	it("accepts names with leading dots and internal spaces or dots", async () => {
		const zip = makeZip({
			"SKILL.md": "# demo",
			".gitignore": "node_modules",
			"my notes/v1.2 draft.md": "docs",
		});
		await fsStore.saveFromZip("demo", zip);
		expect(fs.existsSync(path.join(basePath, "demo", ".gitignore"))).toBe(true);
		expect(
			fs.readFileSync(
				path.join(basePath, "demo", "my notes", "v1.2 draft.md"),
				"utf-8",
			),
		).toBe("docs");

		await memStore.loadFromZip("demo", zip);
		expect(await memStore.loadFile("demo", "my notes/v1.2 draft.md")).toBe(
			"docs",
		);
	});
});

describe("zip uncompressed-size limit", () => {
	let basePath: string;
	let fsStore: FileSystemSkillStore;
	let memStore: MemorySkillStore;

	beforeEach(async () => {
		basePath = fs.mkdtempSync(path.join(os.tmpdir(), "w6-skills-test-"));
		fsStore = new FileSystemSkillStore(basePath);
		await fsStore.initialize();
		memStore = new MemorySkillStore();
	});

	afterEach(() => {
		fs.rmSync(basePath, { recursive: true, force: true });
	});

	it("rejects a zip whose forged central directory declares a huge entry", async () => {
		// Real payload is tiny; the central directory claims a single entry
		// expands past the cap. Rejection must happen before decompression.
		const zip = forgeUncompressedSizes(
			makeZip({ "SKILL.md": "# demo" }),
			MAX_ZIP_UNCOMPRESSED_SIZE + 1,
		);
		await expect(fsStore.saveFromZip("demo", zip)).rejects.toMatchObject({
			code: "SKILL_ZIP_TOO_LARGE",
		});
		await expect(memStore.loadFromZip("demo", zip)).rejects.toMatchObject({
			code: "SKILL_ZIP_TOO_LARGE",
		});
		expect(fs.existsSync(path.join(basePath, "demo"))).toBe(false);
	});

	it("rejects when the sum of entry sizes exceeds the cap", async () => {
		const perEntry = Math.floor(MAX_ZIP_UNCOMPRESSED_SIZE / 2) + 1;
		const zip = forgeUncompressedSizes(
			makeZip({ "SKILL.md": "# demo", "data.bin": "x" }),
			perEntry,
		);
		await expect(fsStore.saveFromZip("demo", zip)).rejects.toMatchObject({
			code: "SKILL_ZIP_TOO_LARGE",
		});
	});

	it("rejects a buffer that is not a zip archive", async () => {
		const garbage = encoder.encode("this is not a zip file at all");
		await expect(fsStore.saveFromZip("demo", garbage)).rejects.toMatchObject({
			code: "SKILL_ZIP_INVALID",
		});
	});

	it("accepts a zip whose declared sizes are within the cap", async () => {
		const zip = makeZip({ "SKILL.md": "# demo", "data.txt": "small" });
		await fsStore.saveFromZip("demo", zip);
		expect(await fsStore.loadSkillContent("demo")).toBe("# demo");
	});
});

describe("filesystem path containment", () => {
	let outerDir: string;
	let basePath: string;
	let store: FileSystemSkillStore;

	beforeEach(async () => {
		// Two-level fixture: the store root sits in its own sandbox parent so a
		// containment regression can only ever delete this test's own directory.
		outerDir = fs.mkdtempSync(path.join(os.tmpdir(), "w6-skills-outer-"));
		basePath = path.join(outerDir, "skills");
		store = new FileSystemSkillStore(basePath);
		await store.initialize();
	});

	afterEach(() => {
		fs.rmSync(outerDir, { recursive: true, force: true });
	});

	it("refuses to write a package file outside the skill directory", async () => {
		await expect(
			store.saveSkill({
				slug: "demo",
				files: new Map([
					[
						"../../escape.txt",
						{ path: "../../escape.txt", content: "payload", isText: true },
					],
				]),
			}),
		).rejects.toMatchObject({ code: "SKILL_PATH_TRAVERSAL" });
		expect(fs.existsSync(path.join(outerDir, "escape.txt"))).toBe(false);
		expect(fs.existsSync(path.join(basePath, "escape.txt"))).toBe(false);
	});

	it("validates every package path before creating a partial skill", async () => {
		await expect(
			store.saveSkill({
				slug: "demo",
				files: new Map([
					[
						"SKILL.md",
						{ path: "SKILL.md", content: "# demo", isText: true },
					],
					[
						"../../escape.txt",
						{ path: "../../escape.txt", content: "payload", isText: true },
					],
				]),
			}),
		).rejects.toMatchObject({ code: "SKILL_PATH_TRAVERSAL" });
		expect(fs.existsSync(path.join(basePath, "demo"))).toBe(false);
	});

	it("refuses to save a package whose slug escapes the base directory", async () => {
		await expect(
			store.saveSkill({
				slug: "../escaped",
				files: new Map([
					["SKILL.md", { path: "SKILL.md", content: "# x", isText: true }],
				]),
			}),
		).rejects.toMatchObject({ code: "SKILL_PATH_TRAVERSAL" });
		expect(fs.existsSync(path.join(outerDir, "escaped"))).toBe(false);
	});

	it("refuses to delete outside the base directory", async () => {
		const canary = path.join(outerDir, "canary.txt");
		fs.writeFileSync(canary, "do not delete");
		await expect(store.deleteSkill("..")).rejects.toMatchObject({
			code: "SKILL_PATH_TRAVERSAL",
		});
		await expect(store.deleteSkill("../..")).rejects.toMatchObject({
			code: "SKILL_PATH_TRAVERSAL",
		});
		expect(fs.readFileSync(canary, "utf-8")).toBe("do not delete");
		// The store itself is untouched by the rejected deletes.
		expect(fs.existsSync(basePath)).toBe(true);
	});

	it("refuses traversal through every public filesystem read/list path", async () => {
		const secretDir = path.join(outerDir, "secret-skill");
		fs.mkdirSync(secretDir);
		fs.writeFileSync(path.join(secretDir, "SKILL.md"), "outside");
		fs.writeFileSync(path.join(outerDir, "secret.txt"), "TOPSECRET");
		fs.mkdirSync(path.join(basePath, "demo"));

		await expect(store.hasSkill("../secret-skill")).rejects.toMatchObject({
			code: "SKILL_PATH_TRAVERSAL",
		});
		await expect(
			store.loadSkillContent("../secret-skill"),
		).rejects.toMatchObject({ code: "SKILL_PATH_TRAVERSAL" });
		await expect(
			store.loadFile("demo", "../../secret.txt"),
		).rejects.toMatchObject({ code: "SKILL_PATH_TRAVERSAL" });
		await expect(store.listFiles("demo", "../..")).rejects.toMatchObject({
			code: "SKILL_PATH_TRAVERSAL",
		});
		expect(() => store.getSkillPath("../secret-skill")).toThrow(
			/escapes the skill directory/,
		);
	});

	it.each(["NUL", "com1.txt", "LPT²", "demo.", "demo ", "name:stream"])(
		"rejects the non-portable storage slug %s across public operations",
		async (slug) => {
			expect(() => store.getSkillPath(slug)).toThrow(/escapes the skill directory/);
			await expect(store.hasSkill(slug)).rejects.toMatchObject({
				code: "SKILL_PATH_TRAVERSAL",
			});
			await expect(store.loadSkillContent(slug)).rejects.toMatchObject({
				code: "SKILL_PATH_TRAVERSAL",
			});
			await expect(store.listFiles(slug)).rejects.toMatchObject({
				code: "SKILL_PATH_TRAVERSAL",
			});
			await expect(store.deleteSkill(slug)).rejects.toMatchObject({
				code: "SKILL_PATH_TRAVERSAL",
			});
			await expect(
				store.saveSkill({
					slug,
					files: new Map([
						["SKILL.md", { path: "SKILL.md", content: "# x", isText: true }],
					]),
				}),
			).rejects.toMatchObject({ code: "SKILL_PATH_TRAVERSAL" });
		},
	);

	it.runIf(process.platform !== "win32")(
		"omits pre-existing non-portable directory aliases from listings",
		async () => {
			for (const slug of ["NUL", "com1.txt", "demo.", "demo ", "name:stream"]) {
				const dir = path.join(basePath, slug);
				fs.mkdirSync(dir);
				fs.writeFileSync(path.join(dir, "SKILL.md"), "# unsafe alias");
			}
			fs.mkdirSync(path.join(basePath, "portable-skill"));
			fs.writeFileSync(
				path.join(basePath, "portable-skill", "SKILL.md"),
				"# portable",
			);

			expect(await store.listSkills()).toEqual(["portable-skill"]);
		},
	);

	it.runIf(process.platform !== "win32")(
		"rejects reads, writes, lists, and deletes through a child symlink",
		async () => {
			const outside = path.join(outerDir, "outside");
			fs.mkdirSync(outside);
			fs.writeFileSync(path.join(outside, "SKILL.md"), "outside");
			fs.symlinkSync(outside, path.join(basePath, "linked"), "dir");

			await expect(store.hasSkill("linked")).rejects.toMatchObject({
				code: "SKILL_PATH_TRAVERSAL",
			});
			await expect(store.loadSkillContent("linked")).rejects.toMatchObject({
				code: "SKILL_PATH_TRAVERSAL",
			});
			await expect(store.loadFile("linked", "SKILL.md")).rejects.toMatchObject({
				code: "SKILL_PATH_TRAVERSAL",
			});
			await expect(store.listFiles("linked")).rejects.toMatchObject({
				code: "SKILL_PATH_TRAVERSAL",
			});
			await expect(
				store.saveSkill({
					slug: "linked",
					files: new Map([
						[
							"SKILL.md",
							{ path: "SKILL.md", content: "changed", isText: true },
						],
					]),
				}),
			).rejects.toMatchObject({ code: "SKILL_PATH_TRAVERSAL" });
			await expect(store.deleteSkill("linked")).rejects.toMatchObject({
				code: "SKILL_PATH_TRAVERSAL",
			});
			expect(fs.readFileSync(path.join(outside, "SKILL.md"), "utf8")).toBe(
				"outside",
			);
		},
	);

	it.runIf(process.platform !== "win32")(
		"rejects symlinks that cross into a sibling skill inside the storage root",
		async () => {
			const firstDir = path.join(basePath, "first");
			const secondDir = path.join(basePath, "second");
			fs.mkdirSync(firstDir);
			fs.mkdirSync(secondDir);
			fs.writeFileSync(path.join(secondDir, "SKILL.md"), "sibling secret");
			fs.writeFileSync(path.join(secondDir, "secret.txt"), "TOPSECRET");
			fs.symlinkSync(
				path.join(secondDir, "SKILL.md"),
				path.join(firstDir, "SKILL.md"),
				"file",
			);
			fs.symlinkSync(secondDir, path.join(firstDir, "linked"), "dir");

			await expect(store.loadSkillContent("first")).rejects.toMatchObject({
				code: "SKILL_PATH_TRAVERSAL",
			});
			await expect(store.hasSkill("first")).rejects.toMatchObject({
				code: "SKILL_PATH_TRAVERSAL",
			});
			await expect(store.loadFile("first", "linked/secret.txt")).rejects.toMatchObject(
				{ code: "SKILL_PATH_TRAVERSAL" },
			);
			await expect(store.listFiles("first", "linked")).rejects.toMatchObject({
				code: "SKILL_PATH_TRAVERSAL",
			});
			expect(await store.listSkills()).toEqual(["second"]);
		},
	);

	it.runIf(process.platform !== "win32")(
		"replaces a skill without following a stored child symlink",
		async () => {
			const outside = path.join(outerDir, "outside");
			const skillDir = path.join(basePath, "demo");
			fs.mkdirSync(outside);
			fs.mkdirSync(skillDir);
			fs.symlinkSync(outside, path.join(skillDir, "linked"), "dir");

			await store.saveSkill({
				slug: "demo",
				files: new Map([
					[
						"linked/nested/file.txt",
						{
							path: "linked/nested/file.txt",
							content: "payload",
							isText: true,
						},
					],
				]),
			});
			expect(fs.existsSync(path.join(outside, "nested"))).toBe(false);
			expect(
				fs.readFileSync(path.join(skillDir, "linked", "nested", "file.txt"), "utf8"),
			).toBe("payload");
		},
	);

	it("still deletes a real skill directory", async () => {
		await store.saveSkill({
			slug: "demo",
			files: new Map([
				[
					"SKILL.md",
					{ path: "SKILL.md", content: "# demo", isText: true },
				],
			]),
		});
		expect(await store.hasSkill("demo")).toBe(true);
		expect(await store.deleteSkill("demo")).toBe(true);
		expect(fs.existsSync(path.join(basePath, "demo"))).toBe(false);
		expect(await store.deleteSkill("demo")).toBe(false);
	});

});
