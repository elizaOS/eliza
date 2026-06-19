import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
	packageName: "@elizaos/plugin-social-alpha",
	viewId: "social-alpha",
	entry: "./src/social-alpha-view-bundle.ts",
	outDir: "dist/views",
	componentExport: "SocialAlphaView",
});
