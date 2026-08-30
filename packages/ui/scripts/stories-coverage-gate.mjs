/** Validates and compares deterministic story-coverage summaries. */

export function validateCoverageSummary(value, label = "coverage summary") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const { componentFiles, withStories, missing } = value;
  if (!Number.isInteger(componentFiles) || componentFiles <= 0) {
    throw new TypeError(`${label}.componentFiles must be a positive integer`);
  }
  if (
    !Number.isInteger(withStories) ||
    withStories < 0 ||
    withStories > componentFiles
  ) {
    throw new TypeError(
      `${label}.withStories must be an integer between 0 and componentFiles`,
    );
  }
  if (
    !Array.isArray(missing) ||
    missing.some((file) => typeof file !== "string" || file.length === 0)
  ) {
    throw new TypeError(`${label}.missing must be an array of file paths`);
  }
  if (new Set(missing).size !== missing.length) {
    throw new TypeError(`${label}.missing must not contain duplicate paths`);
  }
  if (missing.some((file, index) => index > 0 && missing[index - 1] > file)) {
    throw new TypeError(`${label}.missing must be sorted`);
  }
  if (missing.length !== componentFiles - withStories) {
    throw new TypeError(
      `${label}.missing length must equal componentFiles minus withStories`,
    );
  }
  return { componentFiles, withStories, missing };
}

export function compareCoverage(currentValue, baselineValue) {
  const current = validateCoverageSummary(currentValue, "current coverage");
  const baseline = validateCoverageSummary(
    baselineValue,
    "story coverage baseline",
  );
  const currentRatio = current.withStories / current.componentFiles;
  const baselineRatio = baseline.withStories / baseline.componentFiles;
  const failures = [];
  if (current.withStories < baseline.withStories) {
    failures.push(
      `withStories decreased from ${baseline.withStories} to ${current.withStories}`,
    );
  }
  if (currentRatio < baselineRatio) {
    failures.push(
      `coverage ratio decreased from ${(baselineRatio * 100).toFixed(1)}% to ${(currentRatio * 100).toFixed(1)}%`,
    );
  }
  const baselineMissing = new Set(baseline.missing);
  const newMissing = current.missing.filter(
    (component) => !baselineMissing.has(component),
  );
  if (newMissing.length > 0) {
    failures.push(
      `new components without stories:\n${newMissing.map((component) => `- ${component}`).join("\n")}`,
    );
  }
  return {
    current,
    baseline,
    currentRatio,
    baselineRatio,
    newMissing,
    failures,
  };
}
