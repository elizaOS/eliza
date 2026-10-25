/** Parses mobile build environment flags shared by platform policies. */

export function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}
