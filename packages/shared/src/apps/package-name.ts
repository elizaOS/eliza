/**
 * Normalizes installed app package names into browser-safe route slugs and
 * display labels without loading the full app-contract or registry graph.
 */

function packageNameToBasename(packageName: string): string {
  return packageName
    .trim()
    .replace(/^@[^/]+\//, "")
    .trim();
}

export function packageNameToAppRouteSlug(packageName: string): string | null {
  const basename = packageNameToBasename(packageName);
  if (!basename) return null;

  const withoutPrefix = basename.replace(/^(app|plugin)-/, "").trim();
  return withoutPrefix || basename;
}

export function packageNameToAppDisplayName(packageName: string): string {
  const slug =
    packageNameToAppRouteSlug(packageName) ??
    packageNameToBasename(packageName);

  return slug
    .split(/[^a-zA-Z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
