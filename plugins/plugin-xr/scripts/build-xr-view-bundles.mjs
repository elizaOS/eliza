import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginXrRoot = resolve(here, "..");
const repoRoot = resolve(pluginXrRoot, "../..");

const bundlePlugins = [
	"plugins/plugin-contacts",
	"plugins/plugin-hyperliquid",
	"plugins/plugin-messages",
	"plugins/app-model-tester",
	"plugins/plugin-phone",
	"plugins/plugin-polymarket",
	"plugins/plugin-shopify",
	"plugins/plugin-wallet-ui",
	"plugins/plugin-feed",
	"plugins/plugin-app-control",
	"plugins/plugin-screenshare",
	"plugins/plugin-task-coordinator",
	"plugins/plugin-trajectory-logger",
	"plugins/plugin-training",
	"plugins/plugin-facewear",
];

for (const pluginDir of bundlePlugins) {
	const result = spawnSync("bun", ["run", "--cwd", pluginDir, "build:views"], {
		cwd: repoRoot,
		stdio: "inherit",
		env: process.env,
	});

	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}
