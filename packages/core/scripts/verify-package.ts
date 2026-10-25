/** Verify the real tarball in a temporary consumer with no workspace aliases. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const core = fileURLToPath(new URL("..", import.meta.url));
const repository = path.resolve(core, "../..");
const temporary = mkdtempSync(path.join(tmpdir(), "eliza-core-consumer-"));
const env = {
	...process.env,
	NODE_OPTIONS: "",
	ELIZA_STATE_DIR: path.join(temporary, "state"),
};
type PackageManifest = {
	name: string;
	exports: Record<
		string,
		string | { import?: string; default?: string; types?: string }
	>;
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
};
const run = (command: string, args: string[], cwd: string) =>
	execFileSync(command, args, { cwd, env, encoding: "utf8", stdio: "pipe" });
try {
	run(process.execPath, ["scripts/clean-src-artifacts.ts", "--check"], core);
	const manifest: PackageManifest = JSON.parse(
		readFileSync(path.join(core, "package.json"), "utf8"),
	);
	assert.ok(manifest.exports["."], "The Node runtime entrypoint is required");
	for (const [subpath, target] of Object.entries(manifest.exports)) {
		const distribution =
			typeof target === "string" ? target : (target.import ?? target.default);
		if (typeof distribution === "string" && !distribution.includes("*")) {
			assert.ok(
				existsSync(path.join(core, distribution)),
				`Missing published export ${subpath}: ${distribution}`,
			);
		}
		if (typeof target === "object" && target.types) {
			assert.ok(
				existsSync(path.join(core, target.types)),
				`Missing declarations for ${subpath}`,
			);
		}
	}
	const packed = new Map();
	function pack(directory: string) {
		const pkg: PackageManifest = JSON.parse(
			readFileSync(path.join(directory, "package.json"), "utf8"),
		);
		if (packed.has(pkg.name)) return;
		const filename = `${pkg.name.replaceAll(/[/@]/g, "_")}.tgz`;
		const output = path.join(temporary, filename);
		run(
			"bun",
			["pm", "pack", "--ignore-scripts", "--filename", output, "--quiet"],
			directory,
		);
		packed.set(pkg.name, output);
		for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
			if (version.startsWith("workspace:"))
				pack(path.join(repository, "packages", name.replace("@elizaos/", "")));
		}
	}
	pack(core);
	pack(path.join(repository, "packages/host"));
	pack(path.join(repository, "packages/voice"));
	const consumer = path.join(temporary, "consumer");
	mkdirSync(consumer);
	writeFileSync(
		path.join(consumer, "package.json"),
		JSON.stringify({
			private: true,
			type: "module",
			dependencies: Object.fromEntries(packed),
			overrides: Object.fromEntries(packed),
		}),
	);
	run("bun", ["install", "--ignore-scripts"], consumer);
	// Resolve the installed production graph, including present optional packages.
	// Development dependencies are not part of the published runtime contract.
	const visited = new Set();
	const dependencyNames = new Set();
	function inspectDependencies(manifestPath: string) {
		const canonical = realpathSync(manifestPath);
		if (visited.has(canonical)) return;
		visited.add(canonical);
		const pkg: PackageManifest = JSON.parse(readFileSync(canonical, "utf8"));
		dependencyNames.add(pkg.name);
		assert.ok(
			!/^@elizaos\/(?:host$|contracts$|voice$|cloud(?:-|$)|registry(?:-|$)|credentials$|vault$|testing$|prompts$|retrieval$|plugin-)/.test(
				pkg.name,
			) &&
				!/^(?:@ai-sdk\/|@anthropic-ai\/|@openrouter\/|@aws-sdk\/|@google\/(?:genai|generative-ai)|@electric-sql\/|@napi-rs\/keyring$|ai$|openai$|handlebars$|drizzle-orm$|pg$|postgres$|keytar$)/.test(
					pkg.name,
				),
			`Packed kernel pulls non-kernel dependency ${pkg.name}`,
		);
		const resolver = createRequire(canonical);
		for (const name of Object.keys({
			...pkg.dependencies,
			...pkg.optionalDependencies,
		})) {
			const installed = resolver.resolve
				.paths(name)
				?.map((directory) => path.join(directory, name, "package.json"))
				.find(existsSync);
			if (!installed && Object.hasOwn(pkg.optionalDependencies ?? {}, name))
				continue;
			assert.ok(
				installed,
				`Missing production dependency ${name} of ${pkg.name}`,
			);
			inspectDependencies(installed);
		}
	}
	inspectDependencies(
		path.join(consumer, "node_modules/@elizaos/core/package.json"),
	);
	console.log(
		`Packed kernel installed production closure (${visited.size} packages): ${[...dependencyNames].sort().join(", ")}`,
	);

	writeFileSync(
		path.join(consumer, "browser.ts"),
		'import * as protocol from "@elizaos/core/protocol"; Object.assign(globalThis, { protocol });\n',
	);
	run(
		"bun",
		["build", "browser.ts", "--target=browser", "--outfile=browser.js"],
		consumer,
	);
	console.log("Packed protocol bundles for browsers without Node built-ins");

	// The test host supplies storage; it must not enter the published kernel closure.
	run(
		"bun",
		[
			"build",
			path.join(repository, "plugins/plugin-sqlite/index.ts"),
			"--target=node",
			"--format=esm",
			"--external",
			"@elizaos/core",
			"--outfile",
			path.join(consumer, "adapter.mjs"),
		],
		repository,
	);
	copyFileSync(
		new URL("./fixtures/verify.ts", import.meta.url),
		path.join(consumer, "verify.ts"),
	);
	copyFileSync(
		new URL("./fixtures/consumer.ts", import.meta.url),
		path.join(consumer, "consumer.ts"),
	);
	run(
		process.execPath,
		[
			path.join(repository, "node_modules/typescript/bin/tsc"),
			// The consumer supplies every compiler option and may live below a
			// repository-local TMPDIR; never inherit an ancestor tsconfig.
			"--ignoreConfig",
			"--noEmit",
			"--strict",
			"--skipLibCheck",
			"--module",
			"NodeNext",
			"--target",
			"ES2024",
			"--types",
			"node",
			"--typeRoots",
			path.join(repository, "node_modules/@types"),
			"consumer.ts",
		],
		consumer,
	);
	process.stdout.write(run(process.execPath, ["verify.ts"], consumer));
	copyFileSync(
		new URL("./fixtures/redaction.ts", import.meta.url),
		path.join(consumer, "redaction.ts"),
	);
	process.stdout.write(run(process.execPath, ["redaction.ts"], consumer));
	copyFileSync(
		new URL("./fixtures/verify-process-guards.mjs", import.meta.url),
		path.join(consumer, "verify-process-guards.mjs"),
	);
	const guarded = spawnSync(process.execPath, ["verify-process-guards.mjs"], {
		cwd: consumer,
		env,
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.ifError(guarded.error);
	assert.equal(guarded.signal, null);
	const restartCode = JSON.parse(
		readFileSync(path.join(core, "src/restart-exit-code.json"), "utf8"),
	).restartExitCode;
	assert.equal(guarded.status, restartCode, guarded.stderr);
	assert.match(guarded.stderr, /packed-host-crash-fixture/);
	assert.match(guarded.stderr, /Requesting supervised restart/);
	console.log(
		"Packed host process guards remain explicit, idempotent, and exit for supervised restart",
	);
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
