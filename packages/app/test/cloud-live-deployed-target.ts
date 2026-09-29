/** Fixed first-party origins for credentialed deployed-browser smoke tests. */
export function cloudLiveDeployedRendererOrigin(
  environment: string | undefined,
): string {
  if (environment === "production") return "https://eliza.app";
  if (!environment || environment === "staging") {
    return "https://staging.eliza-app.pages.dev";
  }
  throw new Error("Unsupported deployed Cloud smoke environment");
}
