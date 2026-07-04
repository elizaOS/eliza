/**
 * Vitest configuration for facewear unit, transport, and React view coverage
 * against source aliases in this sparse workspace.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);

const agentApiSourceDir = fileURLToPath(
	new URL("../../packages/agent/src/api/", import.meta.url),
);
const uiAgentSurfaceSource = fileURLToPath(
	new URL("../../packages/ui/src/agent-surface/index.ts", import.meta.url),
);
const healthMobileSignalSetupSource = fileURLToPath(
	new URL(
		"../plugin-health/src/screen-time/mobile-signal-setup.ts",
		import.meta.url,
	),
);

export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^@elizaos\/agent\/api\/(.+)$/,
				replacement: `${agentApiSourceDir}$1.ts`,
			},
			{
				find: /^@elizaos\/ui\/agent-surface$/,
				replacement: uiAgentSurfaceSource,
			},
			{
				find: /^@elizaos\/plugin-health\/screen-time\/mobile-signal-setup$/,
				replacement: healthMobileSignalSetupSource,
			},
			// Pin a single React copy so jsdom view tests do not mix the workspace
			// and hoisted React peers (which breaks hooks). Mirrors plugin-documents.
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
		// .test.ts run in the default node environment. View component tests live in
		// .test.tsx files and opt into jsdom via a `// @vitest-environment jsdom`
		// docblock at the top of each file.
		include: [
			"src/**/*.test.ts",
			"src/**/*.test.tsx",
			"src/**/__tests__/**/*.test.ts",
			"src/**/__tests__/**/*.test.tsx",
		],
		environment: "node",
	},
});
