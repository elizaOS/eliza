import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "vitest/config";

const coreSrc = path.resolve(__dirname, "../../packages/core/src");
const sharedSrc = path.resolve(__dirname, "../../packages/shared/src");
const loggerSrc = path.resolve(__dirname, "../../packages/logger/src");

const require = createRequire(import.meta.url);
// react-dom is not a direct dependency of this plugin; resolve it through the
// @testing-library/react install (pinned to a react-dom matching react@19) so
// the jsdom render tests load without a per-package react-dom dependency.
const tlRequire = createRequire(
	require.resolve("@testing-library/react/package.json"),
);

export default defineConfig({
	// Automatic JSX runtime so .tsx render tests need no `import React`.
	esbuild: {
		jsx: "automatic",
		jsxImportSource: "react",
	},
	resolve: {
		// Force a single React instance so the view components and any
		// @elizaos/ui hooks share one renderer under jsdom.
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
			// Resolve workspace source for @elizaos/core (and its deps) so the
			// real route handler + ServiceType enum load at test time without a
			// fresh dist build.
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
		include: [
			"src/**/*.{test,spec}.{ts,tsx}",
			"__tests__/**/*.{test,spec}.{ts,tsx}",
		],
		exclude: ["**/node_modules/**", "**/dist/**", "src/tests/**/*"],
		root: path.resolve(__dirname),
		deps: {
			optimizer: {
				web: { enabled: false },
				ssr: { enabled: false },
			},
		},
	},
});
