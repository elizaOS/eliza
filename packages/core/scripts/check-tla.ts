/**
 * Model-checks every TLA+ specification in `tla/` with TLC.
 *
 * Each `tla/<Module>.<variant>.cfg` is one TLC run of `tla/<Module>.tla`. The
 * run passes only when TLC explores the whole state space and reports no
 * invariant, property or deadlock violation. TLC comes from the pinned
 * tla2tools release (sha256-checked) or from `ELIZA_TLA2TOOLS_JAR`.
 *
 * A config that has a `tla/<Module>.<variant>.graph.json` beside it also has
 * its reachable state graph compared with that file; a conformance test
 * compares the same file with the code. `--write` rewrites the files.
 *
 *   node scripts/check-tla.ts [--write] [Module ...]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stateGraphFromDot } from "./tla-graph.ts";

const TLA_TOOLS_VERSION = "1.7.4";
const TLA_TOOLS_SHA256 =
	"936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
const TLA_TOOLS_URL = `https://github.com/tlaplus/tlaplus/releases/download/v${TLA_TOOLS_VERSION}/tla2tools.jar`;
const PASSED = "Model checking completed. No error has been found.";

const specDir = fileURLToPath(new URL("../tla", import.meta.url));

async function resolveJar(): Promise<string> {
	const configured = process.env.ELIZA_TLA2TOOLS_JAR;
	if (configured) return configured;
	const cached = path.join(
		homedir(),
		".cache",
		"elizaos",
		`tla2tools-${TLA_TOOLS_VERSION}.jar`,
	);
	if (!existsSync(cached)) {
		const response = await fetch(TLA_TOOLS_URL);
		if (!response.ok) {
			throw new Error(
				`Download of ${TLA_TOOLS_URL} failed: ${response.status}`,
			);
		}
		const bytes = Buffer.from(await response.arrayBuffer());
		const digest = createHash("sha256").update(bytes).digest("hex");
		if (digest !== TLA_TOOLS_SHA256) {
			throw new Error(
				`tla2tools.jar sha256 ${digest} is not ${TLA_TOOLS_SHA256}`,
			);
		}
		mkdirSync(path.dirname(cached), { recursive: true });
		writeFileSync(`${cached}.partial`, bytes);
		renameSync(`${cached}.partial`, cached);
	}
	return cached;
}

const args = process.argv.slice(2);
const write = args.includes("--write");
const only = new Set(args.filter((arg) => arg !== "--write"));
const runs = readdirSync(specDir)
	.filter((file) => file.endsWith(".cfg"))
	.sort()
	.map((config) => ({ config, module: config.split(".")[0] }))
	.filter((run) => only.size === 0 || only.has(run.module));
if (runs.length === 0) throw new Error(`No TLC configuration in ${specDir}`);

const jar = await resolveJar();
const metaRoot = mkdtempSync(path.join(tmpdir(), "eliza-tlc-"));
const failed: string[] = [];
try {
	for (const { config, module } of runs) {
		const started = performance.now();
		const graphFile = path.join(
			specDir,
			config.replace(/\.cfg$/, ".graph.json"),
		);
		const dotFile = path.join(metaRoot, `${config}.dot`);
		const graph = existsSync(graphFile);
		const result = spawnSync(
			"java",
			[
				"-XX:+UseParallelGC",
				"-cp",
				jar,
				"tlc2.TLC",
				// TLC writes a complete dump only from a single worker.
				"-workers",
				graph ? "1" : "auto",
				"-cleanup",
				"-metadir",
				path.join(metaRoot, config),
				...(graph ? ["-dump", "dot", dotFile] : []),
				"-config",
				config,
				`${module}.tla`,
			],
			{ cwd: specDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
		);
		if (result.error) throw result.error;
		const output = `${result.stdout}${result.stderr}`;
		const seconds = ((performance.now() - started) / 1000).toFixed(1);
		const states = [...output.matchAll(/(\d[\d,]*) distinct states found/g)].at(
			-1,
		)?.[1];
		if (result.status === 0 && output.includes(PASSED)) {
			console.log(`ok   ${config}: ${states} distinct states, ${seconds}s`);
			if (graph) {
				const json = `${JSON.stringify(stateGraphFromDot(readFileSync(dotFile, "utf8")))}\n`;
				if (write) {
					writeFileSync(graphFile, json);
				} else if (readFileSync(graphFile, "utf8") !== json) {
					failed.push(config);
					console.error(
						`FAIL ${path.basename(graphFile)} is stale; run with --write`,
					);
				}
			}
		} else {
			failed.push(config);
			console.error(
				`FAIL ${config} (exit ${result.status}, ${seconds}s)\n${output}`,
			);
		}
	}
} finally {
	rmSync(metaRoot, { recursive: true, force: true });
}
if (failed.length > 0) {
	console.error(`TLC found violations in: ${failed.join(", ")}`);
	process.exit(1);
}
// A module with no configuration is never checked, so it is an error.
if (only.size === 0) {
	const checked = new Set(runs.map((run) => run.module));
	const sources = [...checked].map((module) =>
		readFileSync(path.join(specDir, `${module}.tla`), "utf8"),
	);
	for (const file of readdirSync(specDir)) {
		const module = file.endsWith(".tla") ? file.slice(0, -4) : null;
		if (!module || checked.has(module)) continue;
		if (
			!sources.some((source) =>
				new RegExp(`EXTENDS[^\\n]*\\b${module}\\b`).test(source),
			)
		) {
			throw new Error(`tla/${file} has no TLC configuration`);
		}
	}
}
