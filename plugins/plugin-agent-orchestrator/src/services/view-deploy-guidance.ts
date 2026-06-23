/**
 * Cloud deployment guidance for elizaOS view/plugin builds.
 *
 * View plugins have a different deploy contract from generic web apps:
 * the view bundle must be published, registered as a Cloud app, and wired
 * back into `Plugin.views`/the published manifest with a concrete viewKind.
 */

export interface ViewPluginDeployPromptOptions {
  /** Source directory the sub-agent should treat as the plugin root. */
  sourceDir?: string;
}

export function buildViewPluginDeployPrompt(
  options: ViewPluginDeployPromptOptions = {},
): string {
  const sourceDirLine = options.sourceDir
    ? `- Work from the plugin source directory \`${options.sourceDir}\`; do not assume files outside that tree exist in the Cloud sandbox.`
    : "- Work from the plugin source directory; do not assume local absolute paths exist in the Cloud sandbox.";

  return [
    "--- View Plugin Deployment (Eliza Cloud) ---",
    "This task builds an elizaOS view/plugin for Eliza Cloud. It must be published as an installable Cloud app, not left as local-only files.",
    sourceDirLine,
    "- Build the view bundle (`bun run build:views`, package `build`, or the repo-local equivalent) and verify the exported component named by `Plugin.views.componentExport` loads.",
    "- Publish the built bundle/assets to the Cloud app/container artifact flow so the view receives a Cloud CDN URL.",
    "- Call `apps.create` to register the installable Cloud app; keep the returned `appId`/slug and use follow-up app update APIs for manifest, domain, and monetization metadata.",
    "- Set an explicit `viewKind` (`release`, `preview`, `developer`, or `system`) in the published manifest for every view. Do not rely on legacy `developerOnly` or an implicit default.",
    "- Update `Plugin.views` so each Cloud-published view keeps the correct `id`, `path`, `viewType`, `componentExport`, and Cloud CDN `bundleUrl`.",
    "- If the view calls monetized Cloud APIs or chat endpoints, forward the user's affiliate value with `X-Affiliate-Code` when one is provided. Never hardcode an owner API key in frontend code.",
    "- Cloud app sandboxes are isolated and ephemeral: local agent-workspace files, `localhost`, and unuploaded build outputs will not exist after deploy. Upload/publish every runtime asset the view needs.",
    "- Verify the real deployed artifact before reporting done: confirm the app registration exists, the manifest contains `viewKind`, and the Cloud CDN bundle or live Cloud URL loads.",
  ].join("\n");
}

export function buildLocalViewPluginPrompt(): string {
  return [
    "--- View Plugin Deployment (local sandbox) ---",
    "This task builds an elizaOS view/plugin for the local agent sandbox. Do not deploy it to Cloud unless the task explicitly asks for a hosted/shared Cloud app.",
    "- Register the view through `Plugin.views` with an explicit `viewKind` and the correct `id`, `path`, `viewType`, `componentExport`, and local bundle path/URL.",
    "- Build the local view bundle and verify it appears in `/api/views` and renders in the local runtime before reporting done.",
    "- State that the result is local-sandbox only, and do not report a Cloud URL.",
  ].join("\n");
}
