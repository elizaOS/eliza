import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const src = (relative: string) => path.join(here, "../../packages", relative);

// Regex finds with subpath entries BEFORE the bare-package entries: a plain
// string alias for "@elizaos/shared" would also rewrite
// "@elizaos/shared/steward-session-client" into ".../index.ts/steward-…" once
// the CloudView jsdom suite pulls the @elizaos/ui api graph in. The react pins
// keep a single React copy so jsdom never mixes the workspace and hoisted
// peers (mirrors plugin-birdclaw).
export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@elizaos\/cloud-routing$/, replacement: src("cloud/routing/src/index.ts") },
			{ find: /^@elizaos\/cloud-sdk$/, replacement: src("cloud/sdk/src/index.ts") },
			{ find: /^@elizaos\/core$/, replacement: src("core/src/index.node.ts") },
			{ find: /^@elizaos\/logger$/, replacement: src("logger/src/index.ts") },
			{ find: /^@elizaos\/shared\/(.*)$/, replacement: `${src("shared/src")}/$1` },
			{ find: /^@elizaos\/shared$/, replacement: src("shared/src/index.ts") },
			{ find: /^@elizaos\/ui\/(.*)$/, replacement: `${src("ui/src")}/$1` },
			{ find: /^@elizaos\/ui$/, replacement: src("ui/src/index.ts") },
			{
				find: /^react$/,
				replacement: path.dirname(require.resolve("react/package.json")),
			},
			{
				find: /^react\/jsx-runtime$/,
				replacement: require.resolve("react/jsx-runtime"),
			},
			{
				find: /^react\/jsx-dev-runtime$/,
				replacement: require.resolve("react/jsx-dev-runtime"),
			},
			{
				find: /^react-dom$/,
				replacement: path.dirname(require.resolve("react-dom/package.json")),
			},
			{
				find: /^react-dom\/client$/,
				replacement: require.resolve("react-dom/client"),
			},
		],
	},
	test: {
		include: ["__tests__/**/*.test.ts", "src/**/*.test.{ts,tsx}"],
		// dist-packaging drives the real build.ts, which is bun-only
		// (import.meta.dir); it runs under `bun test` in the cloud sweep and can
		// never execute under vitest — excluded here (extending the defaults) so
		// the package's vitest lane (incl. the Windows plugins shard) stays green
		// without weakening the gate.
		exclude: [...configDefaults.exclude, "__tests__/dist-packaging.test.ts"],
		environment: "node",
		server: {
			deps: {
				inline: [/@elizaos\//],
			},
		},
	},
});
