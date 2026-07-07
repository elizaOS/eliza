/**
 * Vitest configuration for app-control unit, jsdom, and source-alias test lanes.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "vitest/config";

const sharedSrc = path.resolve(__dirname, "../../packages/shared/src");
const coreSrc = path.resolve(__dirname, "../../packages/core/src");
const cloudRoutingSrc = path.resolve(
	__dirname,
	"../../packages/cloud/routing/src",
);
const loggerSrc = path.resolve(__dirname, "../../packages/logger/src");
const tuiSrc = path.resolve(__dirname, "../../packages/tui/src");
const uiSrc = path.resolve(__dirname, "../../packages/ui/src");
const require = createRequire(import.meta.url);
// react-dom is not a direct dependency of this plugin; resolve it through the
// @testing-library/react install (which pins react-dom@19.2.5, matching react).
const tlRequire = createRequire(
	require.resolve("@testing-library/react/package.json"),
);

export default defineConfig({
	// Use the automatic JSX runtime so .tsx render tests need no `import React`.
	esbuild: {
		jsx: "automatic",
		jsxImportSource: "react",
	},
	resolve: {
		// Force a single React instance so the view components and the
		// @elizaos/ui agent-surface hook share one renderer under jsdom.
		dedupe: ["react", "react-dom"],
		alias: [
			{
				// @elizaos/ui DynamicViewLoader statically imports this plugin-health
				// subpath; anchor it to source (no built plugin-health dist in the
				// keyless lane). Self-contained so it needs no config-local path vars.
				find: /^@elizaos\/plugin-health\/screen-time\/mobile-signal-setup$/,
				replacement: new URL(
					"../plugin-health/src/screen-time/mobile-signal-setup.ts",
					import.meta.url,
				).pathname,
			},
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
				replacement: path.dirname(tlRequire.resolve("react-dom/package.json")),
			},
			{
				find: /^react-dom\/client$/,
				replacement: tlRequire.resolve("react-dom/client"),
			},
			{
				find: /^react-dom\/server$/,
				replacement: tlRequire.resolve("react-dom/server"),
			},
			// The view component imports only `useAgentElement` from the
			// agent-surface subpath. Resolve it to source so the hook shares the
			// same React singleton instead of the prebuilt dist bundle.
			{
				find: "@elizaos/ui/agent-surface",
				replacement: path.join(uiSrc, "agent-surface/useAgentElement.ts"),
			},
			{
				find: "@elizaos/ui/events",
				replacement: path.join(uiSrc, "events/index.ts"),
			},
			// The spatial view + terminal renderer import the spatial primitives
			// and the TUI engine. Resolve both to source so their internal React
			// hooks share the same singleton as the test renderer (otherwise the
			// prebuilt dist bundle pulls in a second React copy). Order matters:
			// the `/tui` subpath must match before the bare `/spatial` barrel.
			{
				find: "@elizaos/ui/spatial/tui",
				replacement: path.join(uiSrc, "spatial/tui/index.ts"),
			},
			{
				find: "@elizaos/ui/spatial",
				replacement: path.join(uiSrc, "spatial/index.ts"),
			},
			// React-free settings-section metadata consumed by the VIEWS action's
			// subview deep-linking (token resolution + planner subview list).
			// Resolve to source so tests need no built @elizaos/ui dist.
			{
				find: "@elizaos/ui/components/settings/settings-section-tokens",
				replacement: path.join(
					uiSrc,
					"components/settings/settings-section-tokens.ts",
				),
			},
			{
				find: "@elizaos/ui/components/settings/settings-section-meta",
				replacement: path.join(
					uiSrc,
					"components/settings/settings-section-meta.ts",
				),
			},
			// Canonical VAD capture defaults, resolved to source so the settings
			// drift-guard test can assert the SETTINGS voice defaults never diverge
			// from what the running capture path uses. Load-safe: the module only
			// imports a pure helper and touches browser globals inside functions.
			{
				find: "@elizaos/ui/voice/local-asr-capture",
				replacement: path.join(uiSrc, "voice/local-asr-capture.ts"),
			},
			{
				find: "@elizaos/tui",
				replacement: path.join(tuiSrc, "index.ts"),
			},
			// Use workspace source for @elizaos/shared and @elizaos/core so
			// recently-added exports resolve at test time without requiring
			// a fresh dist build of either package.
			{
				find: /^@elizaos\/shared\/(.*)\.js$/,
				replacement: path.join(sharedSrc, "$1.ts"),
			},
			{
				find: /^@elizaos\/shared\/(.*)$/,
				replacement: path.join(sharedSrc, "$1.ts"),
			},
			{
				find: "@elizaos/shared",
				replacement: path.join(sharedSrc, "index.ts"),
			},
			{
				find: /^@elizaos\/core\/(.*)\.js$/,
				replacement: path.join(coreSrc, "$1.ts"),
			},
			{
				find: "@elizaos/core",
				replacement: path.join(coreSrc, "index.node.ts"),
			},
			// Core's src re-exports the cloud routing surface from
			// `@elizaos/cloud-routing`, which ships no dist. With @elizaos/core
			// pinned to source above, that re-export only resolves when
			// cloud-routing is source-aliased too — otherwise vite falls through
			// to its missing `dist/index.js` and fails to resolve the entry.
			{
				find: "@elizaos/cloud-routing",
				replacement: path.join(cloudRoutingSrc, "index.ts"),
			},
			{
				find: "@elizaos/logger",
				replacement: path.join(loggerSrc, "index.ts"),
			},
		],
	},
	test: {
		globals: false,
		environment: "node",
		include: ["src/**/*.test.{ts,tsx}"],
		exclude: ["node_modules", "dist"],
		root: path.resolve(__dirname),
		coverage: {
			reporter: ["text", "json", "html"],
			exclude: ["node_modules", "dist", "**/*.test.{ts,tsx}"],
		},
		deps: {
			optimizer: {
				web: { enabled: false },
				ssr: { enabled: false },
			},
		},
	},
});
