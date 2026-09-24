/** Android 17 Siso compatibility settings shared by physical-device builds. */

const REQUIRED_EXPERIMENT = "ignore-missing-targets";

export function withSisoCompatibility(env = process.env) {
  const experiments = new Set(
    (env.SISO_EXPERIMENTS ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  experiments.add(REQUIRED_EXPERIMENT);
  return {
    ...env,
    SISO_EXPERIMENTS: [...experiments].join(","),
  };
}
