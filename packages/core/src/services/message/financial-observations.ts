/**
 * Grounds numerical wallet holdings in the wallet reads supplied to this turn.
 * Portfolio valuation, prices, raw token units, and absent assets do not prove
 * a token quantity. Provider state remains distinct from action success.
 */
import type { ActionResult } from "../../types/components";
import type { StateData } from "../../types/state";
import { isObjectRecord } from "../../utils/type-guards";

interface Holding {
	symbol: string;
	amount: string;
}

function decimal(value: unknown): string | undefined {
	if (typeof value !== "string" && typeof value !== "number") return undefined;
	if (typeof value === "number" && (!Number.isFinite(value) || value < 0))
		return undefined;
	let text = String(value).trim();
	// JavaScript may serialize a finite provider quantity in exponent notation.
	// Expand that representation without rounding the original decimal digits.
	if (typeof value === "number" && /e/i.test(text)) {
		const [mantissa, exponentText] = text.toLowerCase().split("e");
		const [whole, fraction = ""] = mantissa.split(".");
		const digits = whole + fraction;
		const point = whole.length + Number(exponentText);
		text =
			point <= 0
				? `0.${"0".repeat(-point)}${digits}`
				: point >= digits.length
					? digits + "0".repeat(point - digits.length)
					: `${digits.slice(0, point)}.${digits.slice(point)}`;
	}
	if (!/^\d+(?:\.\d+)?$/.test(text)) return undefined;
	const [whole, fraction = ""] = text.split(".");
	const normalizedWhole = whole.replace(/^0+(?=\d)/, "");
	const normalizedFraction = fraction.replace(/0+$/, "");
	return normalizedFraction
		? `${normalizedWhole}.${normalizedFraction}`
		: normalizedWhole;
}

function holding(symbol: unknown, amount: unknown): Holding | undefined {
	if (typeof symbol !== "string" || !symbol.trim()) return undefined;
	const normalized = decimal(amount);
	return normalized === undefined
		? undefined
		: { symbol: symbol.trim().toUpperCase(), amount: normalized };
}

function portfolioHoldings(value: unknown): Holding[] {
	if (!isObjectRecord(value) || value.success === false) return [];
	const data = isObjectRecord(value.data) ? value.data : value;
	if (!Array.isArray(data.items)) return [];
	return data.items.flatMap((item) => {
		if (!isObjectRecord(item)) return [];
		const observed = holding(item.symbol, item.uiAmount);
		return observed ? [observed] : [];
	});
}

function observedHoldings(
	results: readonly ActionResult[],
	providers: StateData["providers"],
): Holding[] {
	const observations: Holding[] = [];
	for (const result of results) {
		if (
			result.success !== true ||
			result.data?.actionName !== "WALLET" ||
			result.data.subaction !== "search_address" ||
			result.data.target !== "birdeye" ||
			!Array.isArray(result.data.results)
		)
			continue;
		for (const lookup of result.data.results) {
			if (
				!isObjectRecord(lookup) ||
				!isObjectRecord(lookup.result) ||
				lookup.result.success !== true
			)
				continue;
			observations.push(...portfolioHoldings(lookup.result));
		}
	}
	for (const [name, provider] of Object.entries(providers ?? {})) {
		const data = provider.data;
		if (!data || data.success === false) continue;
		if (name === "get-balance") {
			const observed = holding(data.token, data.balance);
			if (observed) observations.push(observed);
		} else if (name === "solana-wallet") {
			observations.push(...portfolioHoldings(data));
		} else if (
			name === "BIRDEYE_WALLET_PORTFOLIO" ||
			name === "BIRDEYE_TRADE_PORTFOLIO"
		) {
			observations.push(...portfolioHoldings(data.portfolio));
		}
	}
	return observations;
}

const UNVERIFIED =
	/\b(?:cannot|can't|unable|unavailable|unknown|unverified|not\s+(?:verified|confirmed)|if|unless|whether|could|would)\b/i;
const NON_ASSET_UNITS =
	/^(?:seconds?|minutes?|hours?|days?|weeks?|times?|attempts?|results?|assets?|items?|tokens?|coins?)$/i;

function holdingClaims(
	reply: string,
	request: string | undefined,
): Array<Holding & { personal: boolean }> {
	const claims: Array<Holding & { personal: boolean }> = [];
	const walletRequest =
		/\b(?:wallet|crypto|token|holdings|portfolio|SOL|ETH|BTC|USDC|USDT)\b/i.test(
			request ?? "",
		);
	const clauses = reply
		.split(/(?<=[.!?])\s+|\n/u)
		.filter((sentence) => !sentence.includes("?"))
		.flatMap((sentence) =>
			sentence.split(/;\s*|,\s+|\s+(?:and|but|however)\s+/iu),
		);
	for (const clause of clauses) {
		const holdingContext =
			/\b(?:wallet|holdings|portfolio|(?:token|SOL|ETH|BTC|USDC|USDT)\s+balance)\b/i.test(
				clause,
			) ||
			(walletRequest &&
				/\b(?:balance|holds|contains|(?:you|I)\s+(?:(?:currently|now|still)\s+)?(?:have|hold|own))\b/i.test(
					clause,
				)) ||
			(walletRequest &&
				/^\s*\d[\d,.]*\s+[A-Za-z][A-Za-z0-9]*[.!]?\s*$/.test(clause));
		if (!holdingContext) continue;
		for (const match of clause.matchAll(
			/(?<![\w.+-])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s+([A-Za-z][A-Za-z0-9]*)\b/g,
		)) {
			const prefix = clause.slice(0, match.index);
			if (
				UNVERIFIED.test(prefix) ||
				/\b(?:worth|valuation|price|valued|not|don't|doesn't|isn't|aren't)\b/i.test(
					prefix,
				)
			)
				continue;
			if (NON_ASSET_UNITS.test(match[2])) continue;
			const claim = holding(match[2], match[1].replace(/,/g, ""));
			if (claim)
				claims.push({
					...claim,
					personal: /\b(?:you|your|my|I)\b/i.test(clause),
				});
		}
	}
	return claims;
}

/** Missing holdings stay unknown; only an explicit observed zero can prove zero. */
export function financialHoldingIsUngrounded(args: {
	reply: string;
	request?: string;
	actionResults: readonly ActionResult[];
	providers?: StateData["providers"];
}): boolean {
	const observations = observedHoldings(args.actionResults, args.providers);
	// Address lookups can target arbitrary third parties. Only configured wallet
	// providers supply personal-wallet context; a public lookup cannot establish ownership.
	const personalObservations = observedHoldings([], args.providers);
	return holdingClaims(args.reply, args.request).some(
		(claim) =>
			!(claim.personal ? personalObservations : observations).some(
				(observed) =>
					observed.symbol === claim.symbol && observed.amount === claim.amount,
			),
	);
}
