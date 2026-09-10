/**
 * Matches asserted financial completion to the settled wallet or trading
 * operation from this turn. Router preparation and balance observations are
 * not evidence of submission; an unrelated successful operation is not proof.
 */
import type { ActionResult } from "../../types/components";
import { isObjectRecord } from "../../utils/type-guards";

type FinancialOperation = "transfer" | "swap" | "bridge" | "order" | "gov";
type FinancialClaim = {
	operation: FinancialOperation;
	governanceOperation?: "propose" | "vote" | "queue" | "execute";
	requiresSettlement: boolean;
};

const COMPLETION =
	/\b(?:submitted|sent|transferred|swapped|bridged|executed|completed|placed|queued|voted|proposed|confirmed|settled|finalized|filled)\b/i;
const NON_ASSERTION =
	/\b(?:not|never|failed|rejected|unable|cannot|can't|couldn't|didn't|hasn't|haven't|wasn't|weren't|isn't|aren't|if|unless|once|when|whether|would|could|should|will|can|may|might)\b/i;

function financialClaims(reply: string): FinancialClaim[] {
	const claims: FinancialClaim[] = [];
	for (const sentence of reply.split(
		/(?<=[.!?;])\s+|\n|\s+(?:but|however)\s+|\s+and\s+(?=(?:I|we|the|your)\b)/iu,
	)) {
		const completion = COMPLETION.exec(sentence);
		if (
			!completion ||
			NON_ASSERTION.test(sentence.slice(0, completion.index)) ||
			sentence.includes("?")
		)
			continue;
		const requiresSettlement = [
			...sentence.matchAll(new RegExp(COMPLETION.source, "gi")),
		].some(
			(match) =>
				/\b(?:transferred|swapped|bridged|executed|completed|queued|voted|confirmed|settled|finalized|filled)\b/i.test(
					match[0],
				) && !NON_ASSERTION.test(sentence.slice(0, match.index)),
		);
		if (
			/\b(?:governance|onchain|on-chain)\s+(?:proposal|vote)|\bproposal\b/i.test(
				sentence,
			)
		) {
			const governanceOperation = /\b(?:executed|execution)\b/i.test(sentence)
				? "execute"
				: /\b(?:queued|queue|queueing)\b/i.test(sentence)
					? "queue"
					: /\b(?:voted|vote|voting)\b/i.test(sentence)
						? "vote"
						: /\b(?:proposed|proposal)\b/i.test(sentence)
							? "propose"
							: undefined;
			if (governanceOperation)
				claims.push({
					operation: "gov",
					governanceOperation,
					requiresSettlement,
				});
		}
		if (/\b(?:order|trade)\b/i.test(sentence))
			claims.push({ operation: "order", requiresSettlement });
		if (/\b(?:swap|swapped)\b/i.test(sentence))
			claims.push({ operation: "swap", requiresSettlement });
		if (/\b(?:bridge|bridged)\b/i.test(sentence))
			claims.push({ operation: "bridge", requiresSettlement });
		if (
			/\btransfer(?:red)?\b/i.test(sentence) ||
			sentence
				.split(/\s+and\s+/i)
				.some(
					(clause) =>
						!/\b(?:swap|bridge|order|trade|governance)\b/i.test(clause) &&
						/\b(?:sent|submitted)\b[^.!?]*\b(?:SOL|ETH|BTC|USDC|USDT|tokens?|funds?|crypto)\b/i.test(
							clause,
						),
				)
		) {
			claims.push({ operation: "transfer", requiresSettlement });
		}
	}
	return claims;
}

function nonemptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function resultProvesClaim(
	result: ActionResult,
	claim: FinancialClaim,
): boolean {
	if (result.success !== true) return false;
	// The existing router results prove provider submission, not confirmation
	// or settlement. Do not promote a transaction identifier into finality.
	if (claim.requiresSettlement) return false;
	const data = result.data;
	if (!data) return false;
	if (claim.operation === "order") {
		return (
			data.actionName === "TRADE" &&
			data.outcome === "submitted" &&
			isObjectRecord(data.order) &&
			nonemptyString(data.order.orderId) &&
			result.values?.tradeActionSucceeded === true
		);
	}
	if (
		data.actionName !== "WALLET" ||
		data.subaction !== claim.operation ||
		data.status !== "submitted" ||
		data.mode !== "execute" ||
		data.dryRun !== false ||
		(!nonemptyString(data.transactionHash) && !nonemptyString(data.signature))
	)
		return false;
	if (claim.operation === "gov") {
		return (
			isObjectRecord(data.metadata) &&
			data.metadata.op === claim.governanceOperation
		);
	}
	return true;
}

/** A missing claim is not a mutation claim, including an ordinary balance read. */
export function financialCompletionIsUngrounded(
	reply: string,
	results: readonly ActionResult[],
	request?: string,
): boolean {
	// Unqualified orders and transfers also exist outside finance. Only the
	// financial action boundary or explicit financial wording supplies that
	// meaning; file transfers and ordinary purchases retain their own guards.
	const financialContext =
		results.some(
			(result) =>
				result.data?.actionName === "WALLET" ||
				result.data?.actionName === "TRADE",
		) ||
		/\b(?:wallet|crypto|on-?chain|governance|Hyperliquid|Polymarket|SOL|ETH|BTC|USDC|USDT)\b/i.test(
			`${request ?? ""}\n${reply}`,
		);
	if (!financialContext) return false;
	return financialClaims(reply).some(
		(claim) => !results.some((result) => resultProvesClaim(result, claim)),
	);
}
