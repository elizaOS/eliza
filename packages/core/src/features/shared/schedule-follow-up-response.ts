export interface ParsedScheduleFollowUpResponse {
	contactName?: string;
	entityId?: string;
	scheduledAt?: string;
	reason?: string;
	priority?: string;
	message?: string;
}

const FIELD_ALIASES: Record<keyof ParsedScheduleFollowUpResponse, string[]> = {
	contactName: ["contactname", "whotofollowupwith"],
	entityId: ["entityid"],
	scheduledAt: ["scheduledat"],
	reason: ["reason", "reasonormessage"],
	priority: ["priority"],
	message: ["message"],
};

function normalizeFieldKey(raw: string): string {
	return raw
		.replace(/[`*_]/g, "")
		.replace(/\([^)]*\)/g, "")
		.replace(/[^a-z0-9]+/gi, "")
		.toLowerCase();
}

function cleanExtractedValue(raw: string): string {
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return "";
	}

	const withoutExplanation = trimmed.replace(/\s+\(.*$/, "").trim();
	const unwrapped = withoutExplanation
		.replace(/^[`'"]+/, "")
		.replace(/[`'"]+$/, "")
		.trim();

	if (
		/^(not available|not explicitly known|not explicitly provided|not known|none|null|n\/a)$/i.test(
			unwrapped,
		)
	) {
		return "";
	}

	return unwrapped;
}

export function extractScheduleFollowUpResponseFromText(
	text: string,
): ParsedScheduleFollowUpResponse | null {
	const result: ParsedScheduleFollowUpResponse = {};

	for (const line of text.split(/\r?\n/)) {
		const candidate = line.trim().replace(/^[-*]\s*/, "");
		const colonIndex = candidate.indexOf(":");
		if (colonIndex === -1) {
			continue;
		}

		const rawKey = candidate.slice(0, colonIndex);
		const rawValue = candidate.slice(colonIndex + 1);
		const normalizedKey = normalizeFieldKey(rawKey);
		const field = (Object.entries(FIELD_ALIASES).find(([, aliases]) =>
			aliases.includes(normalizedKey),
		)?.[0] ?? null) as keyof ParsedScheduleFollowUpResponse | null;
		if (!field) {
			continue;
		}

		result[field] = cleanExtractedValue(rawValue);
	}

	return Object.keys(result).length > 0 ? result : null;
}
