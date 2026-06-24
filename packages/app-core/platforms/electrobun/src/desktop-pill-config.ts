function parseTruthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

/**
 * Whether the optional floating chat-overlay window should be created at
 * startup.
 *
 * The old standalone `?shell=pill` route has been removed, so desktop must not
 * spawn a separate native overlay window unless a developer explicitly opts in
 * to the replacement chat-overlay shell.
 */
export function shouldCreateDesktopPill(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (parseTruthy(env.ELIZA_DESKTOP_DISABLE_PILL)) {
    return false;
  }

  return parseTruthy(env.ELIZA_DESKTOP_PILL);
}
