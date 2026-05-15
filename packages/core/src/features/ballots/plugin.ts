/**
 * Ballots capability — action slice (Wave G).
 *
 * Registers the five atomic ballot actions:
 *   CREATE_SECRET_BALLOT, DISTRIBUTE_BALLOT, SUBMIT_BALLOT_VOTE,
 *   TALLY_BALLOT_IF_THRESHOLD_MET, EXPIRE_BALLOT.
 *
 * The cloud-backed `SecretBallotsClient` is registered by sibling Wave G
 * cloud code and resolved at handler time via `runtime.getService(...)`.
 *
 * This plugin is intentionally NOT auto-enabled. It must be wired into the
 * default plugin set by a follow-up commit (see the package note at the
 * end of the Wave G ticket: "needs ballotsPlugin export wiring follow-up").
 */

import { logger } from "../../logger.ts";
import type { Plugin } from "../../types/index.ts";
import {
	createSecretBallotAction,
	distributeBallotAction,
	expireBallotAction,
	submitBallotVoteAction,
	tallyBallotIfThresholdMetAction,
} from "./actions/index.ts";

export const ballotsPlugin: Plugin = {
	name: "ballots",
	description:
		"M-of-N secret-ballot actions: create / distribute / submit_vote / tally / expire.",
	actions: [
		createSecretBallotAction,
		distributeBallotAction,
		submitBallotVoteAction,
		tallyBallotIfThresholdMetAction,
		expireBallotAction,
	],
	init: async () => {
		logger.info("[BallotsPlugin] Initialized");
	},
};

export default ballotsPlugin;
