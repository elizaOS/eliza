/**
 * Normalizes Node export conditions at the Playwright process boundary.
 * Playwright owns TypeScript transformation for its source graph, while build
 * children must resolve the packages they verify through published exports.
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

export function withoutElizaSourceNodeOptions(value) {
  const options =
    typeof value === "string" && value.trim().length > 0
      ? value.trim().split(/\s+/)
      : [];

  return options
    .filter((option, index) => {
      if (option === SOURCE_CONDITION) return false;
      if (option === "--conditions" && options[index + 1] === "eliza-source") {
        return false;
      }
      return !(
        option === "eliza-source" && options[index - 1] === "--conditions"
      );
    })
    .join(" ");
}
