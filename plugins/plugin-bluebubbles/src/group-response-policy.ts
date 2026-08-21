/**
 * Deterministic response policy for BlueBubbles/iMessage groups. Access policy
 * decides who may contribute; this policy separately decides whether an
 * admitted message invokes the agent or is stored as ambient room context.
 */
import { logger } from "@elizaos/core";

export type BlueBubblesGroupResponsePolicy = "mention_only" | "ambient";
export type BlueBubblesGroupInvocation = "mention" | "reply" | "ambient";

export const DEFAULT_BLUEBUBBLES_GROUP_RESPONSE_POLICY: BlueBubblesGroupResponsePolicy =
	"mention_only";

export function resolveBlueBubblesGroupResponsePolicy(
	raw: unknown,
): BlueBubblesGroupResponsePolicy {
	if (raw === undefined || raw === null || String(raw).trim() === "") {
		return DEFAULT_BLUEBUBBLES_GROUP_RESPONSE_POLICY;
	}
	const normalized = String(raw).trim().toLowerCase().replaceAll("-", "_");
	if (normalized === "mention_only" || normalized === "ambient") {
		return normalized;
	}
	logger.warn(
		{ src: "plugin:bluebubbles", policy: normalized },
		"Unrecognized BLUEBUBBLES_GROUP_RESPONSE_POLICY value; failing closed to mention_only",
	);
	return DEFAULT_BLUEBUBBLES_GROUP_RESPONSE_POLICY;
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function classifyBlueBubblesGroupInvocation(params: {
	text?: string | null;
	agentNames: string[];
	isReplyToAgent: boolean;
}): BlueBubblesGroupInvocation {
	if (params.isReplyToAgent) return "reply";
	const text = params.text ?? "";
	for (const rawName of params.agentNames) {
		const name = rawName.trim();
		if (!name) continue;
		const escaped = escapeRegex(name);
		const atMention = new RegExp(`(^|\\s)@${escaped}(?=\\s|[,:;.!?]|$)`, "i");
		const directAddress = new RegExp(`^${escaped}\\s*[:,]`, "i");
		if (atMention.test(text) || directAddress.test(text.trimStart())) {
			return "mention";
		}
	}
	return "ambient";
}

export function shouldReplyToBlueBubblesGroup(
	policy: BlueBubblesGroupResponsePolicy,
	invocation: BlueBubblesGroupInvocation,
): boolean {
	return policy === "ambient" || invocation !== "ambient";
}
