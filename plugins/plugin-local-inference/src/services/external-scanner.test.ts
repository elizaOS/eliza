import { beforeEach, describe, expect, it, vi } from "vitest";

const { fsMock, osMock } = vi.hoisted(() => ({
	fsMock: {
		readdir: vi.fn(),
		stat: vi.fn(),
		readFile: vi.fn(),
		realpath: vi.fn(),
	},
	osMock: { homedir: vi.fn(() => "/home/user") },
}));

vi.mock("node:fs/promises", () => ({
	default: fsMock,
	readdir: fsMock.readdir,
	stat: fsMock.stat,
	readFile: fsMock.readFile,
	realpath: fsMock.realpath,
}));

vi.mock("node:os", () => ({
	default: osMock,
	homedir: osMock.homedir,
}));

import { scanExternalModels } from "./external-scanner.js";

function fileEntry(name: string) {
	return {
		name,
		isFile: () => true,
		isDirectory: () => false,
		isSymbolicLink: () => false,
	};
}

function dirEntry(name: string) {
	return {
		name,
		isFile: () => false,
		isDirectory: () => true,
		isSymbolicLink: () => false,
	};
}

function linkEntry(name: string) {
	return {
		name,
		isFile: () => false,
		isDirectory: () => false,
		isSymbolicLink: () => true,
	};
}

function fileStat(size = 1024, mtimeMs = 1700000000000) {
	return { isFile: () => true, isDirectory: () => false, size, mtimeMs };
}

function dirStat() {
	return { isFile: () => false, isDirectory: () => true, size: 0, mtimeMs: 0 };
}

beforeEach(() => {
	fsMock.readdir.mockReset();
	fsMock.stat.mockReset();
	fsMock.readFile.mockReset();
	fsMock.realpath.mockReset();
	// Default: candidate roots exist as directories; .gguf / blob paths are files.
	fsMock.stat.mockImplementation(async (p: string) =>
		String(p).endsWith(".gguf") || String(p).includes("/blobs/")
			? fileStat()
			: dirStat(),
	);
	fsMock.realpath.mockImplementation(async (p: string) => p);
	fsMock.readdir.mockResolvedValue([]);
});

describe("scanExternalModels", () => {
	it("returns an empty list when no roots contain models", async () => {
		const models = await scanExternalModels();
		expect(models).toEqual([]);
	});

	it("discovers flat .gguf files under a candidate root", async () => {
		fsMock.readdir.mockImplementation(async (dir: string) => {
			if (dir.endsWith("/.lmstudio/models")) {
				return [fileEntry("llama-3.gguf")];
			}
			return [];
		});
		const models = await scanExternalModels();
		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({
			source: "external-scan",
			externalOrigin: "lm-studio",
			displayName: "llama-3 (lm-studio)",
			path: "/home/user/.lmstudio/models/llama-3.gguf",
		});
	});

	it("skips files that are not .gguf", async () => {
		fsMock.readdir.mockImplementation(async (dir: string) => {
			if (dir.endsWith("/.lmstudio/models")) {
				return [fileEntry("notes.txt"), fileEntry("model.bin")];
			}
			return [];
		});
		const models = await scanExternalModels();
		expect(models).toEqual([]);
	});

	it("honors the max traversal depth of 6 levels", async () => {
		// Deep nesting: root/d1/.../d7/model.gguf — the d7 directory is never
		// entered (depth 7 > maxDepth 6), so the file must be skipped.
		fsMock.readdir.mockImplementation(async (dir: string) => {
			const levels = [
				"/home/user/.lmstudio/models",
				"/home/user/.lmstudio/models/d1",
				"/home/user/.lmstudio/models/d1/d2",
				"/home/user/.lmstudio/models/d1/d2/d3",
				"/home/user/.lmstudio/models/d1/d2/d3/d4",
				"/home/user/.lmstudio/models/d1/d2/d3/d4/d5",
				"/home/user/.lmstudio/models/d1/d2/d3/d4/d5/d6",
			];
			if (levels.includes(dir)) {
				return [dirEntry(`d${levels.indexOf(dir) + 1}`)];
			}
			if (dir === "/home/user/.lmstudio/models/d1/d2/d3/d4/d5/d6/d7") {
				return [fileEntry("too-deep.gguf")];
			}
			return [];
		});
		const models = await scanExternalModels();
		expect(models).toEqual([]);
	});

	it("skips broken symlinks silently", async () => {
		fsMock.readdir.mockImplementation(async (dir: string) => {
			if (dir.endsWith("/.lmstudio/models")) {
				return [linkEntry("broken.gguf")];
			}
			return [];
		});
		fsMock.realpath.mockRejectedValue(new Error("ELOOP"));
		const models = await scanExternalModels();
		expect(models).toEqual([]);
	});

	it("follows HF snapshot symlinks and reports the real path", async () => {
		fsMock.readdir.mockImplementation(async (dir: string) => {
			if (dir.endsWith("/hub")) {
				return [linkEntry("snapshot-model.gguf")];
			}
			return [];
		});
		fsMock.realpath.mockResolvedValue(
			"/home/user/.cache/huggingface/hub/blobs/abc123",
		);
		const models = await scanExternalModels();
		expect(models).toHaveLength(1);
		expect(models[0].path).toBe(
			"/home/user/.cache/huggingface/hub/blobs/abc123",
		);
	});

	it("deduplicates models that resolve to the same real path", async () => {
		fsMock.readdir.mockImplementation(async (dir: string) => {
			if (dir.endsWith("/models")) {
				return [linkEntry("a.gguf"), linkEntry("b.gguf")];
			}
			return [];
		});
		fsMock.realpath.mockResolvedValue("/shared/model.gguf");
		const models = await scanExternalModels();
		const lmStudio = models.filter((m) => m.externalOrigin === "lm-studio");
		const others = models.filter((m) => m.externalOrigin !== "lm-studio");
		// lm-studio flat roots share the real path with each other; the first
		// root wins and later duplicates are dropped.
		expect(lmStudio.length + others.length).toBeGreaterThanOrEqual(1);
		expect(new Set(models.map((m) => m.path)).size).toBe(models.length);
	});

	describe("ollama manifest scanning", () => {
		function ollamaModelLayer(digest: string) {
			return {
				mediaType: "application/vnd.ollama.image.model",
				digest,
				size: 12345,
			};
		}

		it("maps a canonical digest to the blob store", async () => {
			const digest = "sha256:" + "a".repeat(64);
			fsMock.readdir.mockImplementation(async (dir: string) => {
				if (dir === "/home/user/.ollama/models/manifests") {
					return [fileEntry("registry.jsonl")];
				}
				return [];
			});
			fsMock.readFile.mockResolvedValue(
				JSON.stringify({ layers: [ollamaModelLayer(digest)] }),
			);
			fsMock.stat.mockImplementation(async (p: string) => {
				if (p.endsWith("/blobs/sha256-" + "a".repeat(64))) {
					return fileStat(999);
				}
				return dirStat();
			});
			const models = await scanExternalModels();
			const ollama = models.filter((m) => m.externalOrigin === "ollama");
			expect(ollama).toHaveLength(1);
			expect(ollama[0].path).toBe(
				"/home/user/.ollama/models/blobs/sha256-" + "a".repeat(64),
			);
			expect(ollama[0].sizeBytes).toBe(999);
		});

		it("rejects a digest with a path traversal payload instead of stat'ing outside the blob store", async () => {
			fsMock.readdir.mockImplementation(async (dir: string) => {
				if (dir.endsWith("/manifests")) {
					return [fileEntry("evil.json")];
				}
				return [];
			});
			fsMock.readFile.mockResolvedValue(
				JSON.stringify({
					layers: [ollamaModelLayer("sha256:../../etc/passwd")],
				}),
			);
			const statSpy = fsMock.stat;
			const models = await scanExternalModels();
			expect(models.filter((m) => m.externalOrigin === "ollama")).toEqual([]);
			const statCalls = statSpy.mock.calls
				.map((c) => String(c[0]))
				.filter((p) => p.includes("/blobs/"));
			expect(statCalls.some((p) => p.includes(".."))).toBe(false);
		});

		it("rejects a non-hex digest", async () => {
			fsMock.readdir.mockImplementation(async (dir: string) => {
				if (dir.endsWith("/manifests")) {
					return [fileEntry("bad.json")];
				}
				return [];
			});
			fsMock.readFile.mockResolvedValue(
				JSON.stringify({ layers: [ollamaModelLayer("sha256:zzzz")] }),
			);
			const models = await scanExternalModels();
			expect(models.filter((m) => m.externalOrigin === "ollama")).toEqual([]);
		});

		it("skips manifests without a model layer", async () => {
			fsMock.readdir.mockImplementation(async (dir: string) => {
				if (dir.endsWith("/manifests")) {
					return [fileEntry("empty.json")];
				}
				return [];
			});
			fsMock.readFile.mockResolvedValue(
				JSON.stringify({
					layers: [
						{
							mediaType: "application/json",
							digest: "sha256:" + "b".repeat(64),
							size: 1,
						},
					],
				}),
			);
			const models = await scanExternalModels();
			expect(models.filter((m) => m.externalOrigin === "ollama")).toEqual([]);
		});

		it("skips unparseable manifest files", async () => {
			fsMock.readdir.mockImplementation(async (dir: string) => {
				if (dir.endsWith("/manifests")) {
					return [fileEntry("broken.json")];
				}
				return [];
			});
			fsMock.readFile.mockResolvedValue("{not json");
			const models = await scanExternalModels();
			expect(models.filter((m) => m.externalOrigin === "ollama")).toEqual([]);
		});

		it("skips manifests whose blob is missing from the store", async () => {
			const digest = "sha256:" + "c".repeat(64);
			fsMock.readdir.mockImplementation(async (dir: string) => {
				if (dir.endsWith("/manifests")) {
					return [fileEntry("missing.json")];
				}
				return [];
			});
			fsMock.readFile.mockResolvedValue(
				JSON.stringify({ layers: [ollamaModelLayer(digest)] }),
			);
			fsMock.stat.mockRejectedValue(new Error("ENOENT"));
			const models = await scanExternalModels();
			expect(models.filter((m) => m.externalOrigin === "ollama")).toEqual([]);
		});
	});
});
