/**
 * Ballots — action slice (Wave G).
 *
 * Re-exports the atomic actions, the plugin scaffold, and the runtime
 * contract types.
 */

export {
	createSecretBallotAction,
	distributeBallotAction,
	expireBallotAction,
	submitBallotVoteAction,
	tallyBallotIfThresholdMetAction,
} from "./actions/index.ts";
export { ballotsPlugin, ballotsPlugin as default } from "./plugin.ts";
export type {
	CreateSecretBallotInput,
	DistributeOutcome,
	SecretBallotDistributionTarget,
	SecretBallotEnvelope,
	SecretBallotParticipant,
	SecretBallotStatus,
	SecretBallotsClient,
	SecretBallotTallyResult,
	SubmitVoteInput,
	SubmitVoteResult,
	TallyOutcome,
} from "./types.ts";
export { SECRET_BALLOTS_CLIENT_SERVICE } from "./types.ts";
