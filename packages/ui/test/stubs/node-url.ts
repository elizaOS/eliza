// Stub for `node:url` in the Storybook browser catalog. URL/URLSearchParams are
// global in the browser; only fileURLToPath/pathToFileURL need shims (used at
// load by core modules pulled via the @elizaos/shared barrel).
export const fileURLToPath = (url: string | URL): string => {
  const href = typeof url === "string" ? url : url.href;
  return href.startsWith("file://")
    ? href.slice("file://".length) || "/"
    : href;
};
export const pathToFileURL = (path: string): URL =>
  new URL(`file://${path.startsWith("/") ? "" : "/"}${path}`);
export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;

export default { fileURLToPath, pathToFileURL, URL, URLSearchParams };
