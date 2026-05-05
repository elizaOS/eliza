/**
 * Mirrors `elizaos/prompt_compression.compress_prompt_description` (Python):
 * collapse whitespace; cap at 160 chars with "..." suffix.
 */
export function compressPromptDescription(
	description: string | undefined,
): string {
	if (typeof description !== "string" || !description.trim()) {
		return "";
	}

	const compact = description.trim().split(/\s+/).filter(Boolean).join(" ");

	if (compact.length <= 160) {
		return compact;
	}

	return `${compact.slice(0, 157).replace(/\s+$/, "")}...`;
}
