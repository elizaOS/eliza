/**
 * Strictly parses numeric story-checker flags before browser work begins.
 */

export function integerArg(argv, name, defaultValue, minimum) {
  const index = argv.indexOf(name);
  if (index < 0) return defaultValue;
  const raw = argv[index + 1];
  const pattern = minimum === 0 ? /^(0|[1-9]\d*)$/ : /^[1-9]\d*$/;
  const value = pattern.test(raw ?? "") ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(
      `${name} must be ${minimum === 0 ? "a non-negative" : "a positive"} safe integer (received ${JSON.stringify(raw)})`,
    );
  }
  return value;
}
