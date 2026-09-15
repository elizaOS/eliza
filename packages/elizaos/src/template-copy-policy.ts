/** Names excluded from both packaged and rendered CLI template trees. */
export const DEFAULT_SKIP_ENTRIES = new Set([
  ".DS_Store",
  ".git",
  ".turbo",
  ".vite",
  "artifacts",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);
