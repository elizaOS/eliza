/**
 * Ballots feature — runtime contract types.
 *
 * The atomic actions never talk to the cloud directly. They resolve a
 * `SecretBallotsClient` and a `SensitiveRequestDispatchRegistry` via
 * `runtime.getService(...)`. Sibling Wave G cloud code provides the concrete
 * client; this slice only defines the shape.
 */

export type SecretBallotStatus = "open" | "tallied" | "expired" | "canceled";

export interface SecretBallotParticipant {
	identityId: string;
	label?: string;
	channelHint?: string;
}

export interface SecretBallotTallyResult {
	threshold: number;
	totalVotes: number;
	values: string[];
	counts: Record<string, number>;
	tallySchemaVersion: 1;
	tallyMethod: "plaintext_v1";
}

export interface SecretBallotEnvelope {
	ballotId: string;
	organizationId: string;
	agentId: string | null;
	purpose: string;
	participants: SecretBallotParticipant[];
	threshold: number;
	status: SecretBallotStatus;
	/** Tally result; null until the threshold is reached. */
	tallyResult: SecretBallotTallyResult | null;
	/** epoch ms */
	expiresAt: number;
	createdAt: number;
	updatedAt: number;
}

export interface CreateSecretBallotInput {
	purpose: string;
	participants: SecretBallotParticipant[];
	threshold: number;
	expiresInMs?: number;
	metadata?: Record<string, unknown>;
}

export type SecretBallotDistributionTarget = "dm";

export interface SubmitVoteInput {
	ballotId: string;
	scopedToken: string;
	/** Plaintext value (v1). Wave H+ replaces this with a Shamir share. */
	value: string;
}

export type SubmitVoteResult =
	| {
			ok: true;
			outcome: "recorded" | "replay_same_value";
			ballotStatus: SecretBallotStatus;
	  }
	| {
			ok: false;
			reason:
				| "ballot_not_found"
				| "ballot_not_open"
				| "unknown_token"
				| "conflict_different_value"
				| "ballot_expired";
	  };

export interface TallyOutcome {
	tallied: boolean;
	ballot: SecretBallotEnvelope;
	result: SecretBallotTallyResult | null;
}

export interface DistributeOutcome {
	ballotId: string;
	target: SecretBallotDistributionTarget;
	dispatched: number;
}

/**
 * Cloud-backed client for secret ballots. Resolved via
 * `runtime.getService(SECRET_BALLOTS_CLIENT_SERVICE)`.
 *
 * The client's `create` returns the envelope only — the raw participant
 * tokens are NOT exposed to the action layer. Distribution happens via the
 * cloud's DM dispatcher; the action's role is to issue the orchestration
 * call.
 */
export interface SecretBallotsClient {
	create(input: CreateSecretBallotInput): Promise<SecretBallotEnvelope>;
	get(ballotId: string): Promise<SecretBallotEnvelope | null>;
	distribute(input: {
		ballotId: string;
		target: SecretBallotDistributionTarget;
	}): Promise<DistributeOutcome>;
	submitVote(input: SubmitVoteInput): Promise<SubmitVoteResult>;
	tallyIfThresholdMet(input: { ballotId: string }): Promise<TallyOutcome>;
	expireBallot(input: { ballotId: string }): Promise<SecretBallotEnvelope>;
}

export const SECRET_BALLOTS_CLIENT_SERVICE = "SecretBallotsClient";
