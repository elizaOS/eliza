/**
 * Covers the default voice-preset build script: format-valid placeholder
 * output and fail-closed CLI parsing for --dim / --concurrency. Real
 * subprocess harness (deterministic; no network or model load).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	readVoicePresetFile,
	VoicePresetFormatError,
} from "./voice-preset-format";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// .../plugins/plugin-local-inference/src/services/voice -> repo root
const REPO_ROOT = path.resolve(HERE, "../../../../..");
const APP_CORE_ROOT = path.join(REPO_ROOT, "packages", "app-core");
const SCRIPT = path.join(
	APP_CORE_ROOT,
	"scripts",
	"voice-preset",
	"build-default-voice-preset.mjs",
);
const MAX_PLACEHOLDER_DIM = 1_073_741_817;

function runGenerator(args: string[]): string {
	return execFileSync("bun", [SCRIPT, ...args], {
		cwd: APP_CORE_ROOT,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

type CliFailure = {
	status: number | null;
	stdout: string;
	stderr: string;
};

function runGeneratorExpectFailure(args: string[]): CliFailure {
	try {
		const stdout = execFileSync("bun", [SCRIPT, ...args], {
			cwd: APP_CORE_ROOT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { status: 0, stdout, stderr: "" };
	} catch (err) {
		const e = err as {
			status?: number | null;
			stdout?: string;
			stderr?: string;
		};
		return {
			status: e.status ?? null,
			stdout: e.stdout ?? "",
			stderr: e.stderr ?? "",
		};
	}
}

describe("build-default-voice-preset.mjs", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "eliza-voice-preset-gen-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("--placeholder writes a format-valid .bin that round-trips through readVoicePresetFile", () => {
		expect(existsSync(SCRIPT)).toBe(true);
		const out = path.join(dir, "voice-preset-default.bin");
		const stdout = runGenerator(["--placeholder", "--out", out]);
		expect(stdout).toMatch(/PLACEHOLDER/);
		expect(existsSync(out)).toBe(true);

		const parsed = readVoicePresetFile(new Uint8Array(readFileSync(out)));
		expect(parsed.version).toBe(1);
		// Default placeholder embedding dim is 256, all zeros.
		expect(parsed.embedding.length).toBe(256);
		expect(parsed.embedding.every((x) => x === 0)).toBe(true);
		// Placeholder carries no audio.
		expect(parsed.phrases).toHaveLength(0);
	});

	it("--placeholder --dim N honours the embedding dimension", () => {
		const out = path.join(dir, "p.bin");
		runGenerator(["--placeholder", "--dim", "64", "--out", out]);
		const parsed = readVoicePresetFile(new Uint8Array(readFileSync(out)));
		expect(parsed.embedding.length).toBe(64);
	});

	it("accepts explicit valid --concurrency with --placeholder (unused but validated)", () => {
		const out = path.join(dir, "c.bin");
		const stdout = runGenerator([
			"--placeholder",
			"--concurrency",
			"4",
			"--out",
			out,
		]);
		expect(stdout).toMatch(/PLACEHOLDER/);
		expect(existsSync(out)).toBe(true);
		const parsed = readVoicePresetFile(new Uint8Array(readFileSync(out)));
		expect(parsed.embedding.length).toBe(256);
	});

	it("refuses to build a real preset without an embedding (exit 2, guidance message)", () => {
		let threw = false;
		try {
			execFileSync("bun", [SCRIPT], {
				cwd: APP_CORE_ROOT,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (err) {
			threw = true;
			const e = err as { status?: number; stderr?: string };
			expect(e.status).toBe(2);
			expect(e.stderr ?? "").toMatch(/--embedding/);
			expect(e.stderr ?? "").toMatch(/--placeholder/);
		}
		expect(threw).toBe(true);
	});

	// Sanity: a truncated file is rejected by the parser the generator uses.
	it("the parser the generator targets rejects a truncated blob", () => {
		expect(() => readVoicePresetFile(new Uint8Array([1, 2, 3]))).toThrow(
			VoicePresetFormatError,
		);
	});

	describe("fail-closed --dim / --concurrency (issue #18613)", () => {
		it("accepts the largest format-representable --dim without allocating it", () => {
			const out = path.join(dir, "max.bin");
			const result = runGeneratorExpectFailure([
				"--placeholder",
				"--dim",
				String(MAX_PLACEHOLDER_DIM),
				"--out",
				out,
				"--probe-after-dim",
			]);

			expect(result.status).toBe(1);
			expect(result.stderr).toMatch(/Unknown argument: --probe-after-dim/);
			expect(result.stderr).not.toMatch(/--dim must/);
			expect(existsSync(out)).toBe(false);
		});

		it("rejects the first unrepresentable --dim before allocation or output", () => {
			const out = path.join(dir, "too-large.bin");
			const result = runGeneratorExpectFailure([
				"--placeholder",
				"--dim",
				String(MAX_PLACEHOLDER_DIM + 1),
				"--out",
				out,
			]);

			expect(result.status).toBe(1);
			expect(result.stderr).toMatch(
				new RegExp(`--dim.*no greater than ${MAX_PLACEHOLDER_DIM}`),
			);
			expect(existsSync(out)).toBe(false);
		});

		const malformedCases: Array<{
			name: string;
			/** Full argv after SCRIPT; must include --out pointing at a nested path. */
			buildArgs: (out: string) => string[];
			flag: "--dim" | "--concurrency";
		}> = [
			{
				name: "suffix on --dim",
				buildArgs: (out) => ["--placeholder", "--dim", "1junk", "--out", out],
				flag: "--dim",
			},
			{
				name: "suffix on --concurrency",
				buildArgs: (out) => [
					"--placeholder",
					"--concurrency",
					"2junk",
					"--out",
					out,
				],
				flag: "--concurrency",
			},
			{
				name: "fraction on --dim",
				buildArgs: (out) => ["--placeholder", "--dim", "2.5", "--out", out],
				flag: "--dim",
			},
			{
				name: "fraction on --concurrency",
				buildArgs: (out) => [
					"--placeholder",
					"--concurrency",
					"1.5",
					"--out",
					out,
				],
				flag: "--concurrency",
			},
			{
				name: "signed --dim",
				buildArgs: (out) => ["--placeholder", "--dim", "-4", "--out", out],
				flag: "--dim",
			},
			{
				name: "zero --dim",
				buildArgs: (out) => ["--placeholder", "--dim", "0", "--out", out],
				flag: "--dim",
			},
			{
				name: "zero --concurrency",
				buildArgs: (out) => [
					"--placeholder",
					"--concurrency",
					"0",
					"--out",
					out,
				],
				flag: "--concurrency",
			},
			{
				name: "leading zeros on --dim",
				buildArgs: (out) => ["--placeholder", "--dim", "08", "--out", out],
				flag: "--dim",
			},
			{
				name: "non-numeric --dim",
				buildArgs: (out) => ["--placeholder", "--dim", "abc", "--out", out],
				flag: "--dim",
			},
			{
				name: "unsafe integer --dim",
				buildArgs: (out) => [
					"--placeholder",
					"--dim",
					"9007199254740992",
					"--out",
					out,
				],
				flag: "--dim",
			},
			{
				name: "missing --dim value (trailing)",
				// --out first so the missing --dim is truly at argv end.
				buildArgs: (out) => ["--placeholder", "--out", out, "--dim"],
				flag: "--dim",
			},
			{
				name: "flag-shaped --dim value",
				buildArgs: (out) => [
					"--placeholder",
					"--out",
					out,
					"--dim",
					"--no-phrases",
				],
				flag: "--dim",
			},
			{
				name: "missing --concurrency value (trailing)",
				buildArgs: (out) => ["--placeholder", "--out", out, "--concurrency"],
				flag: "--concurrency",
			},
			{
				name: "flag-shaped --concurrency value",
				buildArgs: (out) => [
					"--placeholder",
					"--out",
					out,
					"--concurrency",
					"--no-phrases",
				],
				flag: "--concurrency",
			},
		];

		for (const { name, buildArgs, flag } of malformedCases) {
			it(`rejects ${name} before creating output`, () => {
				const nested = path.join(dir, "nested-out");
				const out = path.join(nested, "malformed.bin");
				const result = runGeneratorExpectFailure(buildArgs(out));
				expect(result.status, result.stderr || result.stdout).not.toBe(0);
				expect(result.status).toBe(1);
				const combined = `${result.stderr}\n${result.stdout}`;
				expect(combined).toMatch(new RegExp(flag));
				expect(combined).toMatch(/positive safe integer/i);
				// Rejection must happen before mkdirSync / writeFileSync.
				expect(existsSync(out)).toBe(false);
				expect(existsSync(nested)).toBe(false);
			});
		}
	});
});
