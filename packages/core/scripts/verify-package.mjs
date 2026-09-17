/** Verify the real tarball in a temporary consumer with no workspace aliases. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
const run = (command, args, cwd) =>
	execFileSync(command, args, { cwd, env, encoding: "utf8", stdio: "pipe" });
try {
	assert.deepEqual(readdirSync(path.join(core, "dist")).sort(), [
		"index.d.ts",
		"index.js",
	]);
	const manifest = JSON.parse(
		readFileSync(path.join(core, "package.json"), "utf8"),
	);
	assert.deepEqual(Object.keys(manifest.exports), ["."]);
	const packed = new Map();
	function pack(directory) {
		const pkg = JSON.parse(
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
	writeFileSync(
		path.join(consumer, "verify.mjs"),
		`
import assert from 'node:assert/strict';
import { AgentRuntime, ModelType, createLogger } from '@elizaos/core';
const runtime = new AgentRuntime({ character: { name: 'packed-kernel', bio: 'deterministic package verification' }, logLevel: 'fatal' });
let calls = 0;
try {
  await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
  assert.equal(runtime.messageService, null);
  assert.equal(runtime.actions.length, 0);
  assert.equal(runtime.providers.length, 0);
  runtime.registerModel(ModelType.TEXT_SMALL, async (_runtime, input) => {
    assert.equal(input.prompt, 'Return the fixture value.');
    calls++;
    return 'fixture:perfect';
  }, 'fixture');
  assert.equal(await runtime.useModel(ModelType.TEXT_SMALL, { prompt: 'Return the fixture value.' }), 'fixture:perfect');
  assert.equal(calls, 1);
  assert.equal(typeof createLogger().info, 'function');
  const publicApi = await import('@elizaos/core');
  for (const hostApi of ['sendJson', 'readJsonBody', 'registerCuratedApp', 'drainAppRoutePluginLoaders', 'getRuntimeRouteHostContext', 'SetupStateMachine', 'CLISetupAdapter', 'SetupRPCService', 'setupProgressProvider']) {
    assert.equal(hostApi in publicApi, false, hostApi + ' must be owned outside core');
  }
  for (const subpath of ['node', 'browser', 'edge', 'testing', 'runtime', 'client-public']) {
    await assert.rejects(import('@elizaos/core/' + subpath), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  }
} finally { await runtime.stop(); }
console.log('Packed kernel boot, deterministic inference, logger and root-only exports verified');
`,
	);
	writeFileSync(
		path.join(consumer, "consumer.ts"),
		`
import { AgentRuntime, ModelType, type IAgentRuntime, type Plugin, type UUID } from '@elizaos/core';
const plugin: Plugin = { name: 'consumer', description: 'typed consumer', models: { [ModelType.TEXT_SMALL]: async (_runtime, _params) => 'fixture' } };
const runtime: IAgentRuntime = new AgentRuntime({ character: { name: 'consumer', bio: [] }, plugins: [plugin] });
const id: UUID = runtime.agentId;
void id;
const text: Promise<string> = runtime.useModel(ModelType.TEXT_SMALL, { prompt: 'fixture' });
void text;
`,
	);
	run(
		process.execPath,
		[
			path.join(repository, "node_modules/typescript/bin/tsc"),
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
	process.stdout.write(run(process.execPath, ["verify.mjs"], consumer));
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
