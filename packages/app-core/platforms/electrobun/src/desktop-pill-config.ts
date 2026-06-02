function parseTruthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parseFalsy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "no";
}

export function shouldCreateDesktopPill(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (parseTruthy(env.ELIZA_DESKTOP_DISABLE_PILL)) {
    return false;
  }

  if (parseFalsy(env.ELIZA_DESKTOP_PILL)) {
    return false;
  }

  // Default on: the pill window is the primary voice surface. Users can
  // suppress it with ELIZA_DESKTOP_PILL=0 or ELIZA_DESKTOP_DISABLE_PILL=1.
  return true;
}
