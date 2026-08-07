/**
 * `prompt` and `max_age` — the two parameters by which a relying party controls
 * HOW the end user is authenticated — and the decision each one forces on a
 * provider that cannot authenticate anybody itself.
 *
 * Sign-in happens in the Eliza Cloud SPA. `/authorize` can only observe the
 * session cookie the SPA already established: it cannot create one, cannot force
 * one to be re-established, has no consent step (the registry is a fixed set of
 * first-party clients), and has no account chooser. Every request for one of
 * those is unsatisfiable here.
 *
 * Ignoring them is the outcome that must not happen: a relying party that asked
 * for a fresh login and silently received a reused session cannot tell the
 * difference, and would report a re-authentication that never occurred. Each
 * unsatisfiable request is instead refused with the OpenID Connect Core 3.1.2.6
 * error code written for it, which the relying party already has handling for.
 *
 * `max_age` is unsatisfiable for a second, independent reason and is refused
 * outright rather than evaluated: this provider cannot observe WHEN the platform
 * session was established. A Steward access token is re-minted on every refresh,
 * so its `iat` is the age of the last refresh, not of the login (`./session.ts`)
 * — which is why no `auth_time` claim is emitted at all. Comparing a freshness
 * bound against that number would answer "authenticated recently" for a session
 * that last saw a password weeks ago, in the direction that admits rather than
 * refuses.
 */

import type { OidcErrorCode } from "./errors";

/** Prompt values this provider can satisfy. Advertised in discovery. */
export const OIDC_SUPPORTED_PROMPT_VALUES = ["none"] as const;

/**
 * Values OpenID Connect Core 3.1.2.1 defines that this provider cannot carry
 * out, each with the 3.1.2.6 error that says so. A value outside this table and
 * `none` is a malformed request, so a typo can never quietly mean "no prompt".
 *
 * A `Map`, not an object literal: the key comes straight off the query string,
 * and an object lookup of `constructor` or `toString` would return an inherited
 * function whose `.error` and `.description` are `undefined` — a rejection with
 * no error code, built from a value the sender chose.
 */
const UNSATISFIABLE_PROMPT_VALUES = new Map<string, { error: OidcErrorCode; description: string }>([
  [
    "login",
    {
      error: "login_required",
      description:
        "This provider cannot re-authenticate an existing Eliza Cloud session. Sign out and start sign-in again.",
    },
  ],
  [
    "consent",
    {
      error: "consent_required",
      description: "This provider has no consent screen.",
    },
  ],
  [
    "select_account",
    {
      error: "account_selection_required",
      description: "This provider has no account chooser.",
    },
  ],
]);

export interface OidcAuthenticationPolicy {
  /** `prompt=none`: answer without any end-user interaction, or fail. */
  promptNone: boolean;
}

export type OidcAuthenticationPolicyResult =
  | { status: "accepted"; policy: OidcAuthenticationPolicy }
  | { status: "rejected"; error: OidcErrorCode; description: string };

function rejected(error: OidcErrorCode, description: string): OidcAuthenticationPolicyResult {
  return { status: "rejected", error, description };
}

/**
 * Parse both parameters, or report the error the relying party must receive.
 *
 * Descriptions are fixed strings and never echo the submitted value: this text
 * is copied into a redirect the relying party renders, and the sender already
 * knows what it sent.
 */
export function resolveOidcAuthenticationPolicy(request: {
  prompt: string | null;
  maxAge: string | null;
}): OidcAuthenticationPolicyResult {
  const values = [...new Set((request.prompt ?? "").split(/\s+/).filter(Boolean))];

  // `none` is a claim about the WHOLE request ("do not interact at all"), so it
  // contradicts every other value rather than combining with it.
  if (values.includes("none") && values.length > 1) {
    return rejected("invalid_request", "prompt=none cannot be combined with other prompt values.");
  }
  for (const value of values) {
    const unsatisfiable = UNSATISFIABLE_PROMPT_VALUES.get(value);
    if (unsatisfiable) return rejected(unsatisfiable.error, unsatisfiable.description);
    if (value !== "none") {
      return rejected("invalid_request", "The prompt parameter contains an unsupported value.");
    }
  }

  if (request.maxAge !== null) {
    // Shape first, so a broken relying party learns it sent nonsense rather
    // than that the parameter is unsupported.
    if (!/^\d+$/.test(request.maxAge) || !Number.isSafeInteger(Number(request.maxAge))) {
      return rejected(
        "invalid_request",
        "max_age must be a non-negative integer number of seconds.",
      );
    }
    return rejected(
      "login_required",
      "This provider cannot establish when the Eliza Cloud session was authenticated, so max_age cannot be honored. Omit max_age, or sign out and start sign-in again.",
    );
  }

  return { status: "accepted", policy: { promptNone: values.includes("none") } };
}
