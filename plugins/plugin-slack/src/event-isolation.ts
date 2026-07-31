/**
 * Multi-workspace event isolation.
 *
 * The connector runs one bolt `App` per account, and until now the only thing
 * tying an inbound event to an account was the closure it happened to be
 * registered in. That is an *assumption*, not a check, and it is the kind of
 * assumption that is fine right up until it isn't:
 *
 *  - two accounts configured with the same app credentials by mistake;
 *  - a Slack Connect / third-partyly-shared channel delivering events that
 *    originate in a team we are not installed in;
 *  - an org-wide install fanning events across workspaces;
 *  - a socket frame arriving on a stale connection after a token swap.
 *
 * Every one of those routes another workspace's message into this account's
 * memory, rooms, and agent context. Attribution by closure cannot detect any
 * of them, because the closure is right about which *socket* the event came in
 * on and wrong about which *workspace* it belongs to.
 *
 * So we check the envelope. Slack stamps every Events API delivery with
 * `api_app_id` and `team_id`; comparing them against the identity we got back
 * from `auth.test` at startup turns the assumption into a verified fact on
 * every single event. Defense in depth: the closure is still the primary
 * attribution, this is the assertion that it was correct.
 *
 * Deliberately fail-open on *absent* fields and fail-closed only on *present
 * and different* ones. A missing `team_id` means an event family that does not
 * carry one (or a hand-built test payload); dropping those would break working
 * deployments to defend against nothing. A mismatched `team_id` is
 * unambiguous, and is dropped.
 */

export interface SlackAccountIdentity {
  /** `api_app_id` from `auth.test`, when the Slack app id is known. */
  apiAppId?: string | null;
  /** `team_id` from `auth.test`. */
  teamId?: string | null;
  /** `enterprise_id`, for org-wide installs. */
  enterpriseId?: string | null;
}

export type SlackIsolationMismatchField =
  | "api_app_id"
  | "team_id"
  | "enterprise_id";

export interface SlackIsolationVerdict {
  drop: boolean;
  field?: SlackIsolationMismatchField;
  expected?: string;
  received?: string;
}

const ACCEPT: SlackIsolationVerdict = { drop: false };

function readString(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "";
}

/**
 * Pulls the workspace identity out of an inbound envelope.
 *
 * Slack is not consistent about where these live across event families and
 * transports, so every known location is checked:
 *  - `team_id` at the envelope root (standard Events API);
 *  - `team.id` (some interactivity and slash payloads);
 *  - `event.team` (message events echo the authoring team);
 *  - `authorizations[0].team_id` (the installation the event was routed for).
 */
export function extractSlackEnvelopeIdentity(body: unknown): {
  apiAppId: string;
  teamId: string;
  enterpriseId: string;
} {
  if (!body || typeof body !== "object") {
    return { apiAppId: "", teamId: "", enterpriseId: "" };
  }
  const raw = body as {
    api_app_id?: unknown;
    team_id?: unknown;
    team?: unknown;
    enterprise_id?: unknown;
    enterprise?: unknown;
    is_enterprise_install?: unknown;
    event?: unknown;
    authorizations?: unknown;
  };

  const apiAppId = readString(raw.api_app_id);

  let teamId = readString(raw.team_id);
  if (!teamId && raw.team && typeof raw.team === "object") {
    teamId = readString((raw.team as { id?: unknown }).id);
  }
  if (!teamId && typeof raw.team === "string") {
    teamId = raw.team;
  }
  if (!teamId && raw.event && typeof raw.event === "object") {
    const event = raw.event as { team?: unknown; team_id?: unknown };
    teamId = readString(event.team) || readString(event.team_id);
  }
  if (!teamId && Array.isArray(raw.authorizations)) {
    const first = raw.authorizations[0] as { team_id?: unknown } | undefined;
    teamId = readString(first?.team_id);
  }

  let enterpriseId = readString(raw.enterprise_id);
  if (!enterpriseId && raw.enterprise && typeof raw.enterprise === "object") {
    enterpriseId = readString((raw.enterprise as { id?: unknown }).id);
  }

  return { apiAppId, teamId, enterpriseId };
}

/**
 * Decides whether an inbound Slack event belongs to this account.
 *
 * Must be called on **every** inbound event family, not just messages: a
 * reaction, a member join, or a file share from a foreign workspace corrupts
 * state just as effectively as a message does.
 */
export function shouldDropMismatchedSlackEvent(params: {
  body: unknown;
  identity: SlackAccountIdentity;
}): SlackIsolationVerdict {
  const { body, identity } = params;
  if (!body || typeof body !== "object") {
    // Nothing to compare against: the closure attribution stands.
    return ACCEPT;
  }

  const received = extractSlackEnvelopeIdentity(body);
  const expectedAppId = readString(identity.apiAppId);
  const expectedTeamId = readString(identity.teamId);
  const expectedEnterpriseId = readString(identity.enterpriseId);

  if (
    expectedAppId &&
    received.apiAppId &&
    received.apiAppId !== expectedAppId
  ) {
    return {
      drop: true,
      field: "api_app_id",
      expected: expectedAppId,
      received: received.apiAppId,
    };
  }

  if (expectedTeamId && received.teamId && received.teamId !== expectedTeamId) {
    // An org-wide install legitimately receives events from sibling workspaces
    // under one enterprise, so a team mismatch inside the *expected*
    // enterprise is not evidence of cross-tenant bleed.
    const enterpriseMatches =
      expectedEnterpriseId.length > 0 &&
      received.enterpriseId === expectedEnterpriseId;
    if (!enterpriseMatches) {
      return {
        drop: true,
        field: "team_id",
        expected: expectedTeamId,
        received: received.teamId,
      };
    }
  }

  if (
    expectedEnterpriseId &&
    received.enterpriseId &&
    received.enterpriseId !== expectedEnterpriseId
  ) {
    return {
      drop: true,
      field: "enterprise_id",
      expected: expectedEnterpriseId,
      received: received.enterpriseId,
    };
  }

  return ACCEPT;
}
