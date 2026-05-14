/**
 * Tests for the voice-model auto-updater (R5-versioning §3 + §6).
 *
 * Coverage:
 * - Cascade order: Cloud → GitHub → HF, with first non-empty winning.
 * - Pin policy blocks updates.
 * - SHA mismatch raises `VoiceModelDownloadError` and unlinks the staging file.
 * - Ed25519 verify is exercised via `cloudCatalogSource` (test wraps a
 *   real signed body so the runtime path is exercised end-to-end).
 * - Decision-rule edge cases: equal version, bundle incompatibility,
 *   netImprovement=false.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { VoiceModelVersion } from "@elizaos/shared";
import {
	cloudCatalogSource,
	downloadVoiceModel,
	fetchVoiceModelCatalog,
	githubReleasesSource,
	latestPerId,
	mergeCatalogs,
	resolveCheckIntervalMs,
	shouldAutoUpdateVoiceModel,
	VoiceModelDownloadError,
	type VoiceModelCatalogSource,
} from "../../src/services/voice-model-updater";

function makeVersion(overrides: Partial<VoiceModelVersion>): VoiceModelVersion {
	return {
		id: "kokoro",
		version: "1.0.0",
		publishedToHfAt: "2026-05-14T00:00:00Z",
		hfRepo: "test/repo",
		hfRevision: "main",
		ggufAssets: [],
		evalDeltas: { netImprovement: true },
		changelogEntry: "test",
		minBundleVersion: "0.0.0",
		...overrides,
	};
}

describe("shouldAutoUpdateVoiceModel", () => {
	const baseline = makeVersion({ version: "1.1.0" });

	it("blocks when pinned", () => {
		const res = shouldAutoUpdateVoiceModel({
			installedVersion: "1.0.0",
			candidate: baseline,
			bundleVersion: "0.1.0",
			pinned: true,
		});
		expect(res.allow).toBe(false);
		expect(res.reason).toBe("pinned");
	});

	it("blocks when installed equal to candidate", () => {
		const res = shouldAutoUpdateVoiceModel({
			installedVersion: "1.1.0",
			candidate: baseline,
			bundleVersion: "0.1.0",
			pinned: false,
		});
		expect(res.allow).toBe(false);
		expect(res.reason).toBe("up-to-date");
	});

	it("blocks when installed greater than candidate", () => {
		const res = shouldAutoUpdateVoiceModel({
			installedVersion: "1.2.0",
			candidate: baseline,
			bundleVersion: "0.1.0",
			pinned: false,
		});
		expect(res.allow).toBe(false);
		expect(res.reason).toBe("up-to-date");
	});

	it("blocks when not installed", () => {
		const res = shouldAutoUpdateVoiceModel({
			installedVersion: null,
			candidate: baseline,
			bundleVersion: "0.1.0",
			pinned: false,
		});
		expect(res.allow).toBe(false);
		expect(res.reason).toBe("not-installed");
	});

	it("blocks when netImprovement=false", () => {
		const candidate = makeVersion({
			version: "1.1.0",
			evalDeltas: { netImprovement: false },
		});
		const res = shouldAutoUpdateVoiceModel({
			installedVersion: "1.0.0",
			candidate,
			bundleVersion: "0.1.0",
			pinned: false,
		});
		expect(res.allow).toBe(false);
		expect(res.reason).toBe("net-regression");
	});

	it("blocks when minBundleVersion above installed bundle", () => {
		const candidate = makeVersion({
			version: "1.1.0",
			minBundleVersion: "2.0.0",
		});
		const res = shouldAutoUpdateVoiceModel({
			installedVersion: "1.0.0",
			candidate,
			bundleVersion: "0.1.0",
			pinned: false,
		});
		expect(res.allow).toBe(false);
		expect(res.reason).toBe("bundle-incompatible");
	});

	it("allows when all gates pass", () => {
		const res = shouldAutoUpdateVoiceModel({
			installedVersion: "1.0.0",
			candidate: baseline,
			bundleVersion: "2.0.0",
			pinned: false,
		});
		expect(res.allow).toBe(true);
		expect(res.reason).toBe("update-available");
	});

	it("skips bundle gate when bundleVersion is empty string (UI listing)", () => {
		const candidate = makeVersion({
			version: "1.1.0",
			minBundleVersion: "99.99.99",
		});
		const res = shouldAutoUpdateVoiceModel({
			installedVersion: "1.0.0",
			candidate,
			bundleVersion: "",
			pinned: false,
		});
		expect(res.allow).toBe(true);
	});
});

describe("fetchVoiceModelCatalog cascade", () => {
	function staticSource(
		id: string,
		versions: VoiceModelVersion[],
		failure?: Error,
	): VoiceModelCatalogSource {
		return {
			id: id as VoiceModelCatalogSource["id"],
			async fetchAll(): Promise<ReadonlyArray<VoiceModelVersion>> {
				if (failure) throw failure;
				return versions;
			},
		};
	}

	it("returns the first non-empty source", async () => {
		const cloud = staticSource("cloud", []);
		const github = staticSource("github", [makeVersion({ id: "vad" })]);
		const hf = staticSource("huggingface", [makeVersion({ id: "kokoro" })]);
		const ctl = new AbortController();
		const got = await fetchVoiceModelCatalog([cloud, github, hf], ctl.signal);
		expect(got).not.toBeNull();
		expect(got?.source).toBe("github");
		expect(got?.versions.map((v) => v.id)).toEqual(["vad"]);
	});

	it("skips a source that throws and falls through", async () => {
		const cloud = staticSource("cloud", [], new Error("boom"));
		const github = staticSource("github", []);
		const hf = staticSource("huggingface", [makeVersion({ id: "kokoro" })]);
		const ctl = new AbortController();
		const got = await fetchVoiceModelCatalog([cloud, github, hf], ctl.signal);
		expect(got?.source).toBe("huggingface");
	});

	it("returns null when every source is empty or fails", async () => {
		const cloud = staticSource("cloud", [], new Error("err"));
		const github = staticSource("github", []);
		const hf = staticSource("huggingface", []);
		const ctl = new AbortController();
		const got = await fetchVoiceModelCatalog([cloud, github, hf], ctl.signal);
		expect(got).toBeNull();
	});

	it("aborts mid-cascade when the signal fires", async () => {
		const ctl = new AbortController();
		const cloud: VoiceModelCatalogSource = {
			id: "cloud",
			async fetchAll(): Promise<ReadonlyArray<VoiceModelVersion>> {
				ctl.abort();
				return [];
			},
		};
		const github = staticSource("github", [makeVersion({})]);
		const got = await fetchVoiceModelCatalog([cloud, github], ctl.signal);
		// Cascade returns null because the signal aborted before reaching github.
		expect(got).toBeNull();
	});
});

describe("latestPerId / mergeCatalogs", () => {
	it("merges remote into local, remote keys win on overlap", () => {
		const local: VoiceModelVersion[] = [
			makeVersion({ id: "kokoro", version: "0.1.0" }),
		];
		const remote: VoiceModelVersion[] = [
			makeVersion({
				id: "kokoro",
				version: "0.1.0",
				hfRevision: "abc1234",
			}),
			makeVersion({ id: "vad", version: "0.2.0" }),
		];
		const merged = mergeCatalogs(local, remote);
		const koko = merged.find(
			(v) => v.id === "kokoro" && v.version === "0.1.0",
		);
		expect(koko?.hfRevision).toBe("abc1234");
		expect(merged.find((v) => v.id === "vad")).toBeTruthy();
	});

	it("keeps local-only versions when not in remote", () => {
		const local: VoiceModelVersion[] = [
			makeVersion({ id: "kokoro", version: "2.0.0-rc.1" }),
		];
		const remote: VoiceModelVersion[] = [];
		const merged = mergeCatalogs(local, remote);
		const koko = merged.find(
			(v) => v.id === "kokoro" && v.version === "2.0.0-rc.1",
		);
		expect(koko).toBeDefined();
	});

	it("picks highest semver per id", () => {
		const merged: VoiceModelVersion[] = [
			makeVersion({ id: "kokoro", version: "0.1.0" }),
			makeVersion({ id: "kokoro", version: "0.2.0" }),
			makeVersion({ id: "vad", version: "1.0.0" }),
			makeVersion({ id: "kokoro", version: "0.1.5" }),
		];
		const latest = latestPerId(merged);
		expect(latest.get("kokoro")?.version).toBe("0.2.0");
		expect(latest.get("vad")?.version).toBe("1.0.0");
	});
});

describe("resolveCheckIntervalMs", () => {
	it("uses env override when valid", () => {
		const prev = process.env.ELIZA_VOICE_UPDATE_INTERVAL_MS;
		process.env.ELIZA_VOICE_UPDATE_INTERVAL_MS = "1000";
		try {
			expect(resolveCheckIntervalMs()).toBe(1000);
		} finally {
			if (prev === undefined) delete process.env.ELIZA_VOICE_UPDATE_INTERVAL_MS;
			else process.env.ELIZA_VOICE_UPDATE_INTERVAL_MS = prev;
		}
	});

	it("falls back to the 4h default when no override", () => {
		const prev = process.env.ELIZA_VOICE_UPDATE_INTERVAL_MS;
		delete process.env.ELIZA_VOICE_UPDATE_INTERVAL_MS;
		try {
			expect(resolveCheckIntervalMs()).toBe(14_400_000);
		} finally {
			if (prev !== undefined) process.env.ELIZA_VOICE_UPDATE_INTERVAL_MS = prev;
		}
	});

	it("ignores invalid env values", () => {
		const prev = process.env.ELIZA_VOICE_UPDATE_INTERVAL_MS;
		process.env.ELIZA_VOICE_UPDATE_INTERVAL_MS = "abc";
		try {
			expect(resolveCheckIntervalMs()).toBe(14_400_000);
		} finally {
			if (prev === undefined) delete process.env.ELIZA_VOICE_UPDATE_INTERVAL_MS;
			else process.env.ELIZA_VOICE_UPDATE_INTERVAL_MS = prev;
		}
	});
});

describe("downloadVoiceModel atomic swap", () => {
	async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
		const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "voice-updater-"));
		try {
			return await fn(dir);
		} finally {
			await fsp.rm(dir, { recursive: true, force: true });
		}
	}

	it("refuses when networkPolicy.allow is false", async () => {
		await withTmp(async (dir) => {
			const version = makeVersion({
				id: "vad",
				ggufAssets: [
					{
						filename: "vad.gguf",
						sha256: "0".repeat(64),
						sizeBytes: 0,
						quant: "fp16",
					},
				],
			});
			await expect(
				downloadVoiceModel({
					version,
					bundleVoiceDir: path.join(dir, "voice"),
					stagingDir: path.join(dir, "staging"),
					assetIndex: 0,
					networkPolicy: {
						class: "cellular",
						allow: false,
						reason: "cellular-ask",
						estimatedBytes: 0,
					},
					signal: new AbortController().signal,
				}),
			).rejects.toThrow(VoiceModelDownloadError);
		});
	});

	it("raises on sha256 mismatch and removes the staging file", async () => {
		await withTmp(async (dir) => {
			const bundleVoiceDir = path.join(dir, "voice");
			const stagingDir = path.join(dir, "staging");
			const filename = "kokoro.gguf";
			const fileBytes = new Uint8Array([1, 2, 3, 4, 5]);

			const fakeFetch = async (
				_url: string,
				init?: RequestInit,
			): Promise<Response> => {
				if (init?.signal?.aborted) {
					return new Response(null, { status: 499 });
				}
				return new Response(fileBytes, { status: 200 });
			};
			const prev = globalThis.fetch;
			globalThis.fetch = fakeFetch as unknown as typeof fetch;

			try {
				const version = makeVersion({
					id: "kokoro",
					version: "1.1.0",
					ggufAssets: [
						{
							filename,
							sha256: "0".repeat(64),
							sizeBytes: fileBytes.byteLength,
							quant: "fp16",
						},
					],
				});
				await expect(
					downloadVoiceModel({
						version,
						bundleVoiceDir,
						stagingDir,
						assetIndex: 0,
						networkPolicy: {
							class: "wifi-unmetered",
							allow: true,
							reason: "auto",
							estimatedBytes: fileBytes.byteLength,
						},
						signal: new AbortController().signal,
					}),
				).rejects.toThrow(/sha256 mismatch/);
				const stagingContents = await fsp.readdir(stagingDir);
				expect(stagingContents).toHaveLength(0);
				const voiceContents = fs.existsSync(bundleVoiceDir)
					? await fsp.readdir(bundleVoiceDir)
					: [];
				expect(voiceContents).toHaveLength(0);
			} finally {
				globalThis.fetch = prev;
			}
		});
	});

	it("happy path renames into the final bundle voice dir", async () => {
		await withTmp(async (dir) => {
			const bundleVoiceDir = path.join(dir, "voice");
			const stagingDir = path.join(dir, "staging");
			const filename = "vad.onnx";
			const fileBytes = new Uint8Array([0xab, 0xcd, 0xef]);
			const { createHash } = await import("node:crypto");
			const sha = createHash("sha256")
				.update(Buffer.from(fileBytes))
				.digest("hex");

			const fakeFetch = async (
				_url: string,
				_init?: RequestInit,
			): Promise<Response> => {
				return new Response(fileBytes, { status: 200 });
			};
			const prev = globalThis.fetch;
			globalThis.fetch = fakeFetch as unknown as typeof fetch;
			try {
				const version = makeVersion({
					id: "vad",
					version: "0.2.0",
					ggufAssets: [
						{
							filename,
							sha256: sha,
							sizeBytes: fileBytes.byteLength,
							quant: "fp16",
						},
					],
				});
				const res = await downloadVoiceModel({
					version,
					bundleVoiceDir,
					stagingDir,
					assetIndex: 0,
					networkPolicy: {
						class: "wifi-unmetered",
						allow: true,
						reason: "auto",
						estimatedBytes: fileBytes.byteLength,
					},
					signal: new AbortController().signal,
				});
				expect(res.sha256).toBe(sha);
				expect(fs.existsSync(res.finalPath)).toBe(true);
				const stagingContents = await fsp.readdir(stagingDir);
				expect(stagingContents).toHaveLength(0);
				// File name embeds id + version so old + new coexist briefly.
				expect(path.basename(res.finalPath)).toContain("vad-0.2.0");
			} finally {
				globalThis.fetch = prev;
			}
		});
	});
});

describe("cloudCatalogSource Ed25519 verify", () => {
	async function generateEd25519(): Promise<{
		publicKeyRaw: Uint8Array;
		signBody: (body: string) => Promise<string>;
	}> {
		// Generate a fresh keypair using Web Crypto so we exercise the same
		// import path as production. Ed25519 keypair primitives are available
		// in Node ≥ 24 and modern browsers.
		const pair = (await crypto.subtle.generateKey(
			{ name: "Ed25519" },
			true,
			["sign", "verify"],
		)) as CryptoKeyPair;
		const exported = await crypto.subtle.exportKey("raw", pair.publicKey);
		const publicKeyRaw = new Uint8Array(exported);
		const signBody = async (body: string): Promise<string> => {
			const sig = await crypto.subtle.sign(
				{ name: "Ed25519" },
				pair.privateKey,
				new TextEncoder().encode(body),
			);
			return Buffer.from(new Uint8Array(sig)).toString("base64");
		};
		return { publicKeyRaw, signBody };
	}

	it("accepts a body with a valid signature", async () => {
		const { publicKeyRaw, signBody } = await generateEd25519();
		const body = JSON.stringify({ versions: [makeVersion({})] });
		const sig = await signBody(body);
		const fakeFetch = async (): Promise<Response> => {
			return new Response(body, {
				status: 200,
				headers: { "X-Eliza-Signature": sig },
			});
		};
		const prev = globalThis.fetch;
		globalThis.fetch = fakeFetch as unknown as typeof fetch;
		try {
			const source = cloudCatalogSource({
				baseUrl: "https://cloud.example",
				publicKeys: [publicKeyRaw],
			});
			const got = await source.fetchAll(new AbortController().signal);
			expect(got).toHaveLength(1);
			expect(got[0]?.id).toBe("kokoro");
		} finally {
			globalThis.fetch = prev;
		}
	});

	it("rejects a body whose signature does not verify", async () => {
		const { publicKeyRaw, signBody } = await generateEd25519();
		const body = JSON.stringify({ versions: [makeVersion({})] });
		const sig = await signBody(`${body}-tampered`);
		const fakeFetch = async (): Promise<Response> => {
			return new Response(body, {
				status: 200,
				headers: { "X-Eliza-Signature": sig },
			});
		};
		const prev = globalThis.fetch;
		globalThis.fetch = fakeFetch as unknown as typeof fetch;
		try {
			const source = cloudCatalogSource({
				baseUrl: "https://cloud.example",
				publicKeys: [publicKeyRaw],
			});
			await expect(
				source.fetchAll(new AbortController().signal),
			).rejects.toThrow();
		} finally {
			globalThis.fetch = prev;
		}
	});
});

describe("githubReleasesSource", () => {
	it("parses release manifests and returns versions", async () => {
		const fakeFetch = async (
			url: string | URL | Request,
		): Promise<Response> => {
			const u = typeof url === "string" ? url : (url as URL).toString();
			if (u.includes("/releases?")) {
				return new Response(
					JSON.stringify([
						{
							tag_name: "kokoro-v1.1.0",
							assets: [
								{
									name: "manifest.json",
									browser_download_url: "https://gh.example/manifest.json",
								},
							],
						},
					]),
					{ status: 200 },
				);
			}
			if (u.includes("/manifest.json")) {
				return new Response(
					JSON.stringify(makeVersion({ id: "kokoro", version: "1.1.0" })),
					{ status: 200 },
				);
			}
			return new Response("not found", { status: 404 });
		};
		const prev = globalThis.fetch;
		globalThis.fetch = fakeFetch as unknown as typeof fetch;
		try {
			const source = githubReleasesSource({
				owner: "elizaOS",
				repo: "eliza-1-voice-models",
			});
			const got = await source.fetchAll(new AbortController().signal);
			expect(got).toHaveLength(1);
			expect(got[0]?.id).toBe("kokoro");
		} finally {
			globalThis.fetch = prev;
		}
	});
});
