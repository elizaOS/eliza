import { type Action } from "@elizaos/core";
import balance from "./balance.ts";
import sendTokens from "./send_tokens.ts";
import stakeBalance from "./stake_balance.ts";

export const bankActions: Action[] = [balance, sendTokens, stakeBalance];

export default bankActions;
