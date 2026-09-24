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
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import process from "node:process";

const ARG_JSON = process.argv.includes("--json");
const ARG_HUMAN = process.argv.includes("--human");
const REQUIRED_ACCELERATOR = resolveRequiredAccelerator();

const SUPPORTED_MODELS = [
	"imagegen-sd-1_5-q5_0",
	"imagegen-sdxl-turbo-q4_0",
	"imagegen-z-image-turbo-q4_k_m",
	"imagegen-flux-1-schnell-q4_k_m",
];

// `auto` and `cpu` are always legal sd-cpp modes. GPU accelerators are added
// only when the binary manifest, --help, or --version proves support.
const BASE_ACCELERATORS = ["auto", "cpu"];

function resolveRequiredAccelerator() {
	const raw = process.env.ELIZA_IMAGEGEN_ACCELERATOR;
	if (typeof raw !== "string" || !raw.trim()) return null;
	const value = raw.trim().toLowerCase();
	return isAccelerator(value) || value === "auto" ? value : null;
}

function resolveBinary() {
	const fromEnv = process.env.SD_CPP_BIN;
	if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
	return "sd";
}

function runCommand(binary, args) {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let proc;
		try {
			proc = spawn(binary, args);
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

function runVersion(binary) {
	return runCommand(binary, ["--version"]);
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

async function probeCapabilities(binary, versionResult) {
	const helpResult = await runCommand(binary, ["--help"]).catch(() => null);
	const manifestAccelerators = await readCapabilityManifest(binary);
	const textEvidence = [
		versionResult.stdout,
		versionResult.stderr,
		helpResult?.stdout ?? "",
		helpResult?.stderr ?? "",
	].join("\n");
	const accelerators = new Set(BASE_ACCELERATORS);
	const evidence = [];
	for (const accelerator of manifestAccelerators) {
		accelerators.add(accelerator);
		evidence.push("manifest");
	}
	if (hasPositiveCudaEvidence(textEvidence)) {
		accelerators.add("cuda");
		evidence.push("help_or_version");
	}
	if (/\b(sd_vulkan|ggml_vulkan|vulkan)\b/i.test(textEvidence)) {
		accelerators.add("vulkan");
	}
	if (/\b(sd_metal|ggml_metal|metal)\b/i.test(textEvidence)) {
		accelerators.add("metal");
	}
	return { accelerators: [...accelerators], evidence: [...new Set(evidence)] };
}

async function readCapabilityManifest(binary) {
	const candidates = [
		`${binary}.json`,
		`${binary}.manifest.json`,
		join(dirname(binary), `${basename(binary)}.manifest.json`),
		join(dirname(binary), "sd-cpp.manifest.json"),
		join(dirname(binary), "manifest.json"),
	];
	for (const candidate of [...new Set(candidates)]) {
		try {
			return extractAccelerators(JSON.parse(await readFile(candidate, "utf8")));
		} catch {
			// Optional sidecar; help/version may still prove capabilities.
		}
	}
	return [];
}

function extractAccelerators(value) {
	const found = new Set();
	const visit = (node) => {
		if (Array.isArray(node)) {
			for (const item of node) visit(item);
			return;
		}
		if (typeof node === "string") {
			const normalized = node.toLowerCase();
			if (isAccelerator(normalized)) found.add(normalized);
			return;
		}
		if (!node || typeof node !== "object") return;
		for (const [key, child] of Object.entries(node)) {
			const normalizedKey = key.toLowerCase();
			if (isAccelerator(normalizedKey) && child === true) {
				found.add(normalizedKey);
			}
			visit(child);
		}
	};
	visit(value);
	return [...found];
}

function isAccelerator(value) {
	return value === "cuda" || value === "vulkan" || value === "metal" || value === "cpu";
}

function hasPositiveCudaEvidence(text) {
	const lower = text.toLowerCase();
	if (
		/(without|no|disabled|disable|not built with|unsupported)[^\n]{0,40}cuda/.test(
			lower,
		)
	) {
		return false;
	}
	return /(^|[^a-z0-9])(sd_cuda|ggml_cuda|cublas|cudart)([^a-z0-9]|$)/.test(lower);
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

	const capabilities = await probeCapabilities(binary, versionResult);
	if (
		REQUIRED_ACCELERATOR &&
		!capabilities.accelerators.includes(REQUIRED_ACCELERATOR)
	) {
		emit({
			available: false,
			binary,
			version: parseVersionLine(versionResult.stdout, versionResult.stderr),
			supportedModels: SUPPORTED_MODELS,
			accelerators: capabilities.accelerators,
			evidence: capabilities.evidence,
			requiredAccelerator: REQUIRED_ACCELERATOR,
			reason: `${REQUIRED_ACCELERATOR}_missing`,
			hint: `'${binary}' is available but does not prove ${REQUIRED_ACCELERATOR} support via manifest, --help, or --version. Use an sd-cpp build for that accelerator or clear ELIZA_IMAGEGEN_ACCELERATOR.`,
		});
		return;
	}
	emit({
		available: true,
		binary,
		version: parseVersionLine(versionResult.stdout, versionResult.stderr),
		supportedModels: SUPPORTED_MODELS,
		accelerators: capabilities.accelerators,
		evidence: capabilities.evidence,
		requiredAccelerator: REQUIRED_ACCELERATOR ?? undefined,
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
			if (payload.requiredAccelerator) {
				lines.push(`required accelerator: ${payload.requiredAccelerator}`);
			}
		} else {
			lines.push(`reason: ${payload.reason}`);
			if (payload.requiredAccelerator) {
				lines.push(`required accelerator: ${payload.requiredAccelerator}`);
			}
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
