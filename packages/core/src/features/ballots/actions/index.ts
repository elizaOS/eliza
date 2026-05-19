/**
 * Ballots actions barrel.
 *
 * Each action stands alone — there is no umbrella discriminator. The planner
 * picks the right atomic verb per turn.
 */

export { createSecretBallotAction } from "./create-secret-ballot.ts";
export { distributeBallotAction } from "./distribute-ballot.ts";
export { expireBallotAction } from "./expire-ballot.ts";
export { submitBallotVoteAction } from "./submit-ballot-vote.ts";
export { tallyBallotIfThresholdMetAction } from "./tally-ballot-if-threshold-met.ts";

// Bundle-safety: force binding identities into the module's init function so
// Bun.build's tree-shake doesn't collapse this barrel into an empty
// `init_X = () => {}`. Without this the on-device mobile agent crashes when
// a consumer dereferences a re-exported binding at runtime.
import { createSecretBallotAction as _bs_create } from "./create-secret-ballot.ts";
import { distributeBallotAction as _bs_distribute } from "./distribute-ballot.ts";
import { expireBallotAction as _bs_expire } from "./expire-ballot.ts";
import { submitBallotVoteAction as _bs_submit } from "./submit-ballot-vote.ts";
import { tallyBallotIfThresholdMetAction as _bs_tally } from "./tally-ballot-if-threshold-met.ts";

const __bundle_safety_FEATURES_BALLOTS_ACTIONS_INDEX__ = [
	_bs_create,
	_bs_distribute,
	_bs_expire,
	_bs_submit,
	_bs_tally,
];
(
	globalThis as Record<string, unknown>
).__bundle_safety_FEATURES_BALLOTS_ACTIONS_INDEX__ =
	__bundle_safety_FEATURES_BALLOTS_ACTIONS_INDEX__;
