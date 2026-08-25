/**
 * Compares story-coverage inventories by missing component identity. Removing a
 * covered component is healthy cleanup; introducing a new uncovered component
 * is the regression the gate must reject, even if another gap disappears.
 */

import path from "node:path";

export function extractLocalStoryImports(source) {
  const imports = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*)["']([^"']+)["']/gu;
  for (const match of source.matchAll(pattern)) {
    if (match[1].startsWith(".")) imports.push(match[1]);
  }
  return imports;
}

export function resolveLocalStoryImport(storyFile, specifier, fileExists) {
  const base = path.resolve(path.dirname(storyFile), specifier);
  for (const candidate of [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    path.join(base, "index.tsx"),
    path.join(base, "index.ts"),
  ]) {
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

export function findStoryCoverageRegressions(report, baseline) {
  if (Array.isArray(baseline.missing)) {
    const allowedMissing = new Set(baseline.missing);
    return report.missing.filter((file) => !allowedMissing.has(file));
  }

  // Older baselines stored counts only. Preserve their debt ceiling until the
  // next explicit update records component identities.
  return report.missingStories > baseline.missingStories
    ? [`${report.missingStories - baseline.missingStories} new missing story`]
    : [];
}
