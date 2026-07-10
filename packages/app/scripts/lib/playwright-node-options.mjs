/**
 * Normalizes Node options inherited by Playwright and its child build processes.
 * Source-conditioned workspace exports point at TypeScript, so the export
 * condition and tsx resolver must travel together through every child process.
 */

const SOURCE_CONDITION = "--conditions=eliza-source";
const TSX_IMPORT = "tsx";

export function withElizaSourceNodeOptions(value) {
  const options =
    typeof value === "string" && value.trim().length > 0
      ? value.trim().split(/\s+/)
      : [];

  if (!options.includes(SOURCE_CONDITION)) {
    options.push(SOURCE_CONDITION);
  }

  const hasTsxImport = options.some(
    (option, index) =>
      option === `--import=${TSX_IMPORT}` ||
      (option === "--import" && options[index + 1] === TSX_IMPORT),
  );
  if (!hasTsxImport) {
    options.push("--import", TSX_IMPORT);
  }

  return options.join(" ");
}
