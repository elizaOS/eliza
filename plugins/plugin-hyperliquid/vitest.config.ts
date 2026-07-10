/**
 * Vitest config for this plugin's unit tests. Aliases React and every
 * `@elizaos/plugin-*` / `@elizaos/app-core` / `@elizaos/core` / `@elizaos/shared`
 * import to source (or an in-package test shim) so tests run against a
 * pre-built dist-less workspace.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const require = createRequire(import.meta.url);

// Alias all @elizaos/plugin-* packages that agent/src imports to their source
// so vitest can resolve them without a pre-built dist. Anchors the find
// pattern to the exact module so subpath imports like
// `@elizaos/plugin-local-inference/runtime` resolve via the package's exports
// map (or the explicit subpath aliases below) instead of being rewritten to
// `<src>/runtime`, which yields ENOTDIR when <src> points to a single file.
function pluginAlias(name: string, srcPath?: string) {
	const src = srcPath ?? path.join(repoRoot, `plugins/${name}/src/index.ts`);
	return { find: new RegExp(`^@elizaos/${name}$`), replacement: src };
}

export default defineConfig({
	root: here,
	resolve: {
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
				find: /^react-dom$/,
				replacement: path.dirname(require.resolve("react-dom/package.json")),
			},
			{
				find: /^react-dom\/client$/,
				replacement: require.resolve("react-dom/client"),
			},
			{
				find: /^@elizaos\/ui$/,
				replacement: path.join(repoRoot, "packages/ui/src/browser.ts"),
			},
			{
				find: /^@elizaos\/ui\/agent-surface$/,
				replacement: path.join(
					repoRoot,
					"packages/ui/src/agent-surface/index.ts",
				),
			},
			{
				find: /^@elizaos\/ui\/events$/,
				replacement: path.join(repoRoot, "packages/ui/src/events/index.ts"),
			},
			{
				find: /^@elizaos\/shared\/local-inference$/,
				replacement: path.join(
					repoRoot,
					"packages/shared/src/local-inference/index.ts",
				),
			},
			{
				find: /^@elizaos\/app-core$/,
				replacement: path.join(here, "__tests__/app-core-shim.ts"),
			},
			{
				find: /^@elizaos\/ui\/spatial$/,
				replacement: path.join(repoRoot, "packages/ui/src/spatial/index.ts"),
			},
			{
				find: /^@elizaos\/app-core\/registry$/,
				replacement: path.join(
					repoRoot,
					"packages/app-core/src/registry/index.ts",
				),
			},
			{
				find: /^@elizaos\/app-core\/(.+)$/,
				replacement: path.join(repoRoot, "packages/app-core/src/$1.ts"),
			},
			{
				find: /^@elizaos\/core$/,
				replacement: path.join(repoRoot, "packages/core/src/index.ts"),
			},
			{
				find: /^@elizaos\/shared$/,
				replacement: path.join(repoRoot, "packages/shared/src/index.ts"),
			},
			{
				find: /^@elizaos\/ui\/spatial$/,
				replacement: path.join(repoRoot, "packages/ui/src/spatial/index.ts"),
			},
			// All plugins in plugins/ that have no pre-built dist — point vitest at
			// source so it can resolve without built artifacts.
			pluginAlias("plugin-agent-orchestrator"),
			pluginAlias("plugin-agent-skills"),
			pluginAlias(
				"plugin-anthropic",
				path.join(repoRoot, "plugins/plugin-anthropic/index.ts"),
			),
			pluginAlias("plugin-aosp-local-inference"),
			pluginAlias("plugin-app-control"),
			pluginAlias("plugin-background-runner"),
			pluginAlias("plugin-bluebubbles"),
			pluginAlias(
				"plugin-bluesky",
				path.join(repoRoot, "plugins/plugin-bluesky/index.ts"),
			),
			pluginAlias("plugin-browser"),
			pluginAlias("plugin-calendly"),
			pluginAlias("plugin-capacitor-bridge"),
			pluginAlias("plugin-cli"),
			pluginAlias(
				"plugin-codex-cli",
				path.join(repoRoot, "plugins/plugin-codex-cli/index.ts"),
			),
			pluginAlias("plugin-coding-tools"),
			pluginAlias("plugin-commands"),
			pluginAlias("plugin-computeruse"),
			pluginAlias("plugin-native-filesystem"),
			pluginAlias(
				"plugin-discord",
				path.join(repoRoot, "plugins/plugin-discord/index.ts"),
			),
			pluginAlias("plugin-discord-local"),
			pluginAlias("plugin-edge-tts"),
			pluginAlias("plugin-elevenlabs"),
			pluginAlias("plugin-elizacloud"),
			pluginAlias(
				"plugin-farcaster",
				path.join(repoRoot, "plugins/plugin-farcaster/index.ts"),
			),
			pluginAlias("plugin-feishu"),
			pluginAlias("plugin-form"),
			pluginAlias("plugin-github"),
			pluginAlias("plugin-google"),
			pluginAlias("plugin-google-chat"),
			pluginAlias(
				"plugin-google-genai",
				path.join(repoRoot, "plugins/plugin-google-genai/index.ts"),
			),
			pluginAlias(
				"plugin-groq",
				path.join(repoRoot, "plugins/plugin-groq/index.ts"),
			),
			pluginAlias("plugin-health"),
			// @elizaos/ui's DynamicViewLoader statically imports this plugin-health
			// subpath; the keyless lane has no built plugin-health dist, so anchor the
			// exact subpath to source (the barrel alias above only matches the bare
			// specifier). Matches plugin-contacts/phone/wallet-ui/facewear.
			{
				find: /^@elizaos\/plugin-health\/screen-time\/mobile-signal-setup$/,
				replacement: path.join(
					repoRoot,
					"plugins/plugin-health/src/screen-time/mobile-signal-setup.ts",
				),
			},
			pluginAlias("plugin-imessage"),
			pluginAlias(
				"plugin-inmemorydb",
				path.join(repoRoot, "plugins/plugin-inmemorydb/index.ts"),
			),
			pluginAlias("plugin-instagram"),
			pluginAlias("plugin-line"),
			pluginAlias("plugin-linear"),
			pluginAlias(
				"plugin-lmstudio",
				path.join(repoRoot, "plugins/plugin-lmstudio/index.ts"),
			),
			pluginAlias(
				"plugin-local-ai",
				path.join(repoRoot, "plugins/plugin-local-ai/index.ts"),
			),
			pluginAlias("plugin-local-inference"),
			// plugin-local-inference exposes subpath exports (`/runtime`, `/routes`,
			// `/services`) consumed via `@elizaos/app-core`; alias each to source so
			// vitest can resolve them without a built dist.
			{
				find: /^@elizaos\/plugin-local-inference\/runtime$/,
				replacement: path.join(
					repoRoot,
					"plugins/plugin-local-inference/src/runtime/index.ts",
				),
			},
			{
				find: /^@elizaos\/plugin-local-inference\/routes$/,
				replacement: path.join(
					repoRoot,
					"plugins/plugin-local-inference/src/routes/index.ts",
				),
			},
			{
				find: /^@elizaos\/plugin-local-inference\/services$/,
				replacement: path.join(
					repoRoot,
					"plugins/plugin-local-inference/src/services/index.ts",
				),
			},
			pluginAlias("plugin-local-storage"),
			pluginAlias(
				"plugin-localdb",
				path.join(repoRoot, "plugins/plugin-localdb/index.ts"),
			),
			pluginAlias("plugin-matrix"),
			pluginAlias("plugin-mcp"),
			pluginAlias("plugin-music"),
			pluginAlias("plugin-ngrok"),
			pluginAlias("plugin-nostr"),
			pluginAlias(
				"plugin-ollama",
				path.join(repoRoot, "plugins/plugin-ollama/index.ts"),
			),
			pluginAlias(
				"plugin-openai",
				path.join(repoRoot, "plugins/plugin-openai/index.ts"),
			),
			pluginAlias(
				"plugin-openrouter",
				path.join(repoRoot, "plugins/plugin-openrouter/index.ts"),
			),
			pluginAlias(
				"plugin-pdf",
				path.join(repoRoot, "plugins/plugin-pdf/index.ts"),
			),
			pluginAlias("plugin-registry"),
			pluginAlias(
				"plugin-shell",
				path.join(repoRoot, "plugins/plugin-shell/index.ts"),
			),
			pluginAlias("plugin-shopify"),
			pluginAlias("plugin-signal"),
			pluginAlias("plugin-slack"),
			pluginAlias("plugin-sql"),
			pluginAlias("plugin-streaming"),
			pluginAlias("plugin-suno"),
			pluginAlias("plugin-tailscale"),
			pluginAlias("plugin-tee"),
			pluginAlias("plugin-telegram"),
			pluginAlias("plugin-todos"),
			pluginAlias("plugin-tunnel"),
			pluginAlias("plugin-twitch"),
			pluginAlias("plugin-video"),
			pluginAlias("plugin-vision"),
			pluginAlias("plugin-wallet"),
			pluginAlias("plugin-web-search"),
			pluginAlias("plugin-wechat"),
			pluginAlias("plugin-whatsapp"),
			pluginAlias("plugin-workflow"),
			pluginAlias("plugin-x"),
			pluginAlias("plugin-x402"),
			pluginAlias(
				"plugin-xai",
				path.join(repoRoot, "plugins/plugin-xai/index.ts"),
			),
			pluginAlias(
				"plugin-zai",
				path.join(repoRoot, "plugins/plugin-zai/index.ts"),
			),
		],
	},
	test: {
		environment: "node",
		include: [
			"src/**/*.test.ts",
			"src/**/*.test.tsx",
			"__tests__/**/*.test.ts",
		],
		exclude: ["dist/**", "node_modules/**"],
	},
});
