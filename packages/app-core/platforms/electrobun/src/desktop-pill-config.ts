function parseTruthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parseFalsy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "no";
}

/**
 * Whether the floating voice-pill window should be created at startup.
 *
 * BEHAVIOR CHANGE (PR #8175): the pill window is now **on by default**.
 * Previously `ELIZA_DESKTOP_PILL=1` was required to opt in; now all desktop
 * users see the pill unless they explicitly opt out.
 *
 * Migration for existing users who did not set `ELIZA_DESKTOP_PILL`:
 *   - Before PR #8175: pill was hidden (opt-in OFF by default).
 *   - After  PR #8175: pill is shown (opt-out, ON by default).
 *
 * To restore the previous hidden behaviour set either:
 *   ELIZA_DESKTOP_PILL=0            (standard off)
 *   ELIZA_DESKTOP_DISABLE_PILL=1    (legacy kill-switch; still respected)
 */
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
