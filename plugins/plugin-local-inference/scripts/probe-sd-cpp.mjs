#!/usr/bin/env node
/**
 * probe-sd-cpp.mjs — WS3 image-gen onboarding probe.
 *
 * Detects whether stable-diffusion.cpp's `sd` binary is reachable on this
 * host. Used by:
 *
 *   - First-run / Settings → Image Generation onboarding to surface a
 *     clean "available: yes/no" badge alongside the per-platform install
 *     instructions.
 *   - `__tests__/imagegen-sd-cpp-probe.test.ts`, which forks this script
 *     to confirm the absent-binary path reports a structured failure
 *     instead of crashing.
 *   - CI bundle-prep step (Linux runners): the build matrix can record
 *     the version + supported models so the validator can cross-check
 *     `ELIZA_1_BUNDLE_EXTRAS.json` against what the binary actually
 *     accepts.
 *
 * Binary resolution order (matches `services/imagegen/sd-cpp.ts`):
 *
 *   1. `process.env.SD_CPP_BIN` (operator override).
 *   2. `sd` on PATH.
 *
 * Output: a single JSON object on stdout, with `available` always
 * present:
 *
 *   { available: true, binary, version, supportedModels, accelerators }
 *   { available: false, binary, reason, hint }
 *
 * Exit code:
 *   0 — the script ran cleanly, regardless of `available`. The caller
 *       inspects `available` to decide whether to enable image-gen.
 *   1 — the probe itself crashed (e.g. JSON.stringify on a circular,
 *       which should not happen).
 *
 * The list of "supported models" is the same per-tier set the bundle
 * extras file ships (sd-1.5 Q5_0, sdxl-turbo Q4_0, z-image-turbo Q4_K_M,
 * flux-1-schnell Q4_K_M). We do not run the binary against each model —
 * that's a real inference workload. The probe only confirms the binary
 * exists and reports its `--version` line.
 */

import { spawn } from "node:child_process";
import process from "node:process";

const ARG_JSON = process.argv.includes("--json");
const ARG_HUMAN = process.argv.includes("--human");

const SUPPORTED_MODELS = [
	"imagegen-sd-1_5-q5_0",
	"imagegen-sdxl-turbo-q4_0",
	"imagegen-z-image-turbo-q4_k_m",
	"imagegen-flux-1-schnell-q4_k_m",
];

// stable-diffusion.cpp accelerator flags (parity with sd-cpp.ts).
const ACCELERATORS = ["auto", "cpu", "cuda", "vulkan", "metal"];

function resolveBinary() {
	const fromEnv = process.env.SD_CPP_BIN;
	if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
	return "sd";
}

function runVersion(binary) {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let proc;
		try {
			proc = spawn(binary, ["--version"]);
		} catch (err) {
			resolve({ ok: false, code: null, error: err, stdout: "", stderr: "" });
			return;
		}
		proc.stdout?.on("data", (b) => {
			stdout += b.toString("utf8");
		});
		proc.stderr?.on("data", (b) => {
			stderr += b.toString("utf8");
		});
		proc.on("error", (err) => {
			resolve({ ok: false, code: null, error: err, stdout, stderr });
		});
		proc.on("exit", (code) => {
			resolve({ ok: code === 0, code, stdout, stderr });
		});
	});
}

function parseVersionLine(stdout, stderr) {
	const text = (stdout || stderr || "").trim();
	if (!text) return null;
	// stable-diffusion.cpp prints lines like `sd  master-xxxxxxx` or
	// `stable-diffusion.cpp v1.0.0`. We don't try to be clever — just
	// return the first non-empty line so onboarding can show it verbatim.
	const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0);
	return firstLine?.trim() ?? null;
}

async function main() {
	const binary = resolveBinary();
	const versionResult = await runVersion(binary);

	if (!versionResult.ok) {
		const reason =
			versionResult.error?.code === "ENOENT" ||
			versionResult.code === null
				? "binary_missing"
				: "binary_version_mismatch";
		const hint =
			reason === "binary_missing"
				? `Install stable-diffusion.cpp ('git clone https://github.com/leejet/stable-diffusion.cpp && make -j') and set SD_CPP_BIN=/path/to/sd, or let the bundle installer place '${binary}' on PATH.`
				: `'${binary} --version' exited with code ${versionResult.code}. The probe expected exit 0. Check the binary build flags.`;
		emit({
			available: false,
			binary,
			reason,
			hint,
		});
		return;
	}

	emit({
		available: true,
		binary,
		version: parseVersionLine(versionResult.stdout, versionResult.stderr),
		supportedModels: SUPPORTED_MODELS,
		accelerators: ACCELERATORS,
	});
}

function emit(payload) {
	if (ARG_HUMAN && !ARG_JSON) {
		const lines = [];
		lines.push(`available: ${payload.available ? "yes" : "no"}`);
		lines.push(`binary: ${payload.binary}`);
		if (payload.available) {
			if (payload.version) lines.push(`version: ${payload.version}`);
			lines.push(
				`supported models: ${(payload.supportedModels ?? []).join(", ")}`,
			);
			lines.push(
				`accelerators: ${(payload.accelerators ?? []).join(", ")}`,
			);
		} else {
			lines.push(`reason: ${payload.reason}`);
			if (payload.hint) lines.push(`hint: ${payload.hint}`);
		}
		process.stdout.write(`${lines.join("\n")}\n`);
		return;
	}
	process.stdout.write(`${JSON.stringify(payload)}\n`);
}

main().catch((err) => {
	process.stderr.write(
		`probe-sd-cpp: unexpected failure: ${err instanceof Error ? err.message : String(err)}\n`,
	);
	process.exit(1);
});
