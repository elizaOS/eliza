import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		"android/bridge": "src/android/bridge.ts",
		"ios/bridge": "src/ios/bridge.ts",
		"mobile-device-bridge-bootstrap": "src/mobile-device-bridge-bootstrap.ts",
		"shared/fs-shim": "src/shared/fs-shim.ts",
	},
	format: ["esm"],
	dts: true,
	clean: true,
	// All `@elizaos/*` workspace packages stay external — the iOS bridge
	// statically imports `dispatchRoute` from `@elizaos/agent`, and the agent's
	// own dep graph pulls in plugin-local-inference, node-llama-cpp, etc.
	// Inlining those drags the entire host runtime (with platform-specific
	// native bindings) into the plugin bundle. Workspace consumers resolve via
	// the workspace symlink at install time; published consumers via npm.
	external: [
		/^@elizaos\//,
		/^@node-llama-cpp\//,
		/^@reflink\//,
		"node-llama-cpp",
		"reflink",
	],
});
