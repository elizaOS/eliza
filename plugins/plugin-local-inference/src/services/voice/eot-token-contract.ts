/**
 * Resolves the paired chat-turn tokens used by the loaded Eliza text model.
 * Current Gemma 4 bundles and older Gemma bundles use different special-token
 * pairs, so semantic endpoint scoring must derive its prompt and target from
 * the tokenizer instead of trusting a model label or filename.
 */

export interface EotTokenContract {
	readonly family: "gemma4" | "gemma-legacy";
	readonly openingToken: string;
	readonly closingToken: string;
	readonly userPrefix: string;
}

export interface ResolvedEotTokenContract extends EotTokenContract {
	readonly openingTokenId: number;
	readonly closingTokenId: number;
}

export const GEMMA4_EOT_TOKEN_CONTRACT: EotTokenContract = {
	family: "gemma4",
	openingToken: "<|turn>",
	closingToken: "<turn|>",
	userPrefix: "<|turn>user\n",
};

export const LEGACY_GEMMA_EOT_TOKEN_CONTRACT: EotTokenContract = {
	family: "gemma-legacy",
	openingToken: "<start_of_turn>",
	closingToken: "<end_of_turn>",
	userPrefix: "<start_of_turn>user\n",
};

const SUPPORTED_CONTRACTS = [
	GEMMA4_EOT_TOKEN_CONTRACT,
	LEGACY_GEMMA_EOT_TOKEN_CONTRACT,
] as const;

export function resolveEotTokenContract(
	tokenizeSpecial: (text: string) => Iterable<number>,
): ResolvedEotTokenContract {
	const attempts: string[] = [];
	for (const contract of SUPPORTED_CONTRACTS) {
		const closingIds = [...tokenizeSpecial(contract.closingToken)];
		const openingIds = [...tokenizeSpecial(contract.openingToken)];
		const closingTokenId = closingIds[0];
		const openingTokenId = openingIds[0];
		if (
			closingIds.length === 1 &&
			openingIds.length === 1 &&
			closingTokenId !== undefined &&
			openingTokenId !== undefined &&
			Number.isInteger(closingTokenId) &&
			Number.isInteger(openingTokenId)
		) {
			return { ...contract, closingTokenId, openingTokenId };
		}
		attempts.push(
			`${contract.family}: ${contract.openingToken}=${JSON.stringify([...openingIds])}, ${contract.closingToken}=${JSON.stringify([...closingIds])}`,
		);
	}

	throw new Error(
		`[voice] The loaded tokenizer does not expose a supported paired turn-token contract (${attempts.join("; ")}).`,
	);
}

/**
 * Leaves the user turn open so the next-token probability of the contract's
 * closing token is the semantic endpoint signal.
 */
export function formatEotPrompt(
	transcript: string,
	contract: EotTokenContract,
): string {
	return `${contract.userPrefix}${transcript.trim()}`;
}
