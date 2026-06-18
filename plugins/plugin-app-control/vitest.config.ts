import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "vitest/config";

const sharedSrc = path.resolve(__dirname, "../../packages/shared/src");
const coreSrc = path.resolve(__dirname, "../../packages/core/src");
const loggerSrc = path.resolve(__dirname, "../../packages/logger/src");
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
			// The view component imports only `useAgentElement` from the
			// agent-surface subpath. Resolve it to source so the hook shares the
			// same React singleton instead of the prebuilt dist bundle.
			{
				find: "@elizaos/ui/agent-surface",
				replacement: path.join(uiSrc, "agent-surface/useAgentElement.ts"),
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
