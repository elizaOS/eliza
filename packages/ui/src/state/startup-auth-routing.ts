/**
 * True when a reachable server expects owner-password sign-in rather than
 * device pairing. Keep this shared by every startup phase that interprets
 * `/api/auth/status` so a later protected-route 401 cannot undo an earlier
 * password-login decision and strand the user on the pairing screen.
 */
export function startupAuthUsesPasswordLogin(auth: {
  required?: boolean;
  loginRequired?: boolean;
  passwordConfigured?: boolean;
}): boolean {
  return auth.loginRequired === true || auth.passwordConfigured === true;
}
