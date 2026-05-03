import fs from "node:fs";
import path from "node:path";

import {
  coverageSurfaceGlobs,
  coverageThresholds,
} from "./coverage-policy.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const SUMMARY_PATH = path.join(ROOT, "coverage", "coverage-summary.json");

if (!fs.existsSync(SUMMARY_PATH)) {
  console.error(
    `Coverage summary not found at ${path.relative(ROOT, SUMMARY_PATH)}.`,
  );
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(SUMMARY_PATH, "utf8"));
const fileEntries = Object.entries(summary).filter(
  ([file]) => file !== "total",
);

function normaliseRelativePath(filePath) {
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(ROOT, filePath);
  return path.relative(ROOT, absolutePath).split(path.sep).join("/");
}

function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL placeholder for glob ** conversion
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function createMetricBucket() {
  return {
    lines: { total: 0, covered: 0 },
    functions: { total: 0, covered: 0 },
    statements: { total: 0, covered: 0 },
    branches: { total: 0, covered: 0 },
  };
}

function addMetric(target, source) {
  for (const key of ["lines", "functions", "statements", "branches"]) {
    target[key].total += source[key]?.total ?? 0;
    target[key].covered += source[key]?.covered ?? 0;
  }
}

function percentage(metric) {
  if (metric.total === 0) return 0;
  return Number(((metric.covered / metric.total) * 100).toFixed(2));
}

const surfaces = Object.entries(coverageSurfaceGlobs).map(
  ([surface, globs]) => ({
    surface,
    globs,
    matchers: globs.map(globToRegExp),
    metrics: createMetricBucket(),
    matchedFiles: new Set(),
  }),
);

for (const [filePath, metrics] of fileEntries) {
  const relativePath = normaliseRelativePath(filePath);
  for (const surface of surfaces) {
    if (!surface.matchers.some((matcher) => matcher.test(relativePath))) {
      continue;
    }
    addMetric(surface.metrics, metrics);
    surface.matchedFiles.add(relativePath);
  }
}

const failures = [];

console.log("Coverage surfaces:");
for (const surface of surfaces) {
  if (surface.matchedFiles.size === 0) {
    failures.push(
      `${surface.surface} did not match any files in coverage-summary.json`,
    );
    continue;
  }

  const line = [
    `- ${surface.surface}`,
    `lines ${percentage(surface.metrics.lines)}%`,
    `functions ${percentage(surface.metrics.functions)}%`,
    `statements ${percentage(surface.metrics.statements)}%`,
    `branches ${percentage(surface.metrics.branches)}%`,
  ].join(" | ");

  console.log(line);

  for (const [metric, threshold] of Object.entries(coverageThresholds)) {
    const actual = percentage(surface.metrics[metric]);
    if (actual < threshold) {
      failures.push(
        `${surface.surface} ${metric} coverage ${actual}% is below ${threshold}%`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("\nCoverage surface policy failures:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}
