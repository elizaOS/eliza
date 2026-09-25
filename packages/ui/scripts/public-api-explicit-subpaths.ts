/**
 * Collect exact non-root package export keys. These are public entry points in
 * their own right, even when their source is not reachable from the root
 * barrel or a wildcard export.
 */
export function collectExplicitSubpathExports(exportsMap, packageName) {
  if (
    !exportsMap ||
    typeof exportsMap !== "object" ||
    Array.isArray(exportsMap)
  ) {
    return [];
  }

  return Object.entries(exportsMap)
    .filter(([key]) => key !== "." && !key.includes("*"))
    .map(([key, target]) => ({
      specifier: key.startsWith("./")
        ? `${packageName}/${key.slice(2)}`
        : `${packageName}/${key}`,
      target,
    }))
    .sort((left, right) => left.specifier.localeCompare(right.specifier));
}

function targetFingerprint(target) {
  return JSON.stringify(target);
}

export function diffExplicitSubpathExports(previous, current) {
  const previousBySpecifier = new Map(
    previous.map((entry) => [entry.specifier, targetFingerprint(entry.target)]),
  );
  const currentBySpecifier = new Map(
    current.map((entry) => [entry.specifier, targetFingerprint(entry.target)]),
  );

  return {
    added: current.filter((entry) => !previousBySpecifier.has(entry.specifier)),
    removed: previous.filter(
      (entry) => !currentBySpecifier.has(entry.specifier),
    ),
    retargeted: current.filter(
      (entry) =>
        previousBySpecifier.has(entry.specifier) &&
        previousBySpecifier.get(entry.specifier) !==
          targetFingerprint(entry.target),
    ),
  };
}
