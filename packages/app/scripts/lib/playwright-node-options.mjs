/**
 * Normalizes Node options inherited by Playwright and its child build processes.
 * Source-conditioned workspace exports must travel through every child
 * process. Playwright owns TypeScript transformation for its test graph.
 */

const SOURCE_CONDITION = "--conditions=eliza-source";

export function withElizaSourceNodeOptions(value) {
  const options =
    typeof value === "string" && value.trim().length > 0
      ? value.trim().split(/\s+/)
      : [];

  if (!options.includes(SOURCE_CONDITION)) {
    options.push(SOURCE_CONDITION);
  }

  return options.join(" ");
}
