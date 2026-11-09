/**
 * Destructive account actions (data export, deletion) need a recent sign-in.
 * When the server answers `recent_auth_required`, send the user through login
 * with the current session ended (`switchAccount=1`, otherwise login would
 * restore the same session) and bring them back here to retry.
 */

import { RecentAuthRequiredError } from "../../lib/api-client";

export function needsSignInAgain(error: unknown): boolean {
  return error instanceof RecentAuthRequiredError;
}

export function signInAgainPath(): string {
  const here =
    typeof window === "undefined"
      ? "/"
      : `${window.location.pathname}${window.location.search}${window.location.hash}`;
  return `/login?switchAccount=1&returnTo=${encodeURIComponent(here)}`;
}
