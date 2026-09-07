/** Assembles complete authorized message or attachment text from revision-bound storage pages. */
import { ElizaError } from "../../errors";
import type { MessageContentRangeReadResult } from "../../types";
import { createHash } from "../../utils/crypto-compat";
import { MESSAGE_CONTENT_SEGMENT_MAX_BYTES } from "./content-segments";

type Range = { offset: number; limit: number; expectedRevision?: string };

export async function readCompleteMessageContent(
	options: Omit<Range, "limit"> & { limit?: number },
	readPage: (range: Range) => Promise<MessageContentRangeReadResult>,
): Promise<MessageContentRangeReadResult> {
	if (options.limit !== undefined)
		return readPage({ ...options, limit: options.limit });
	const first = await readPage({
		...options,
		limit: MESSAGE_CONTENT_SEGMENT_MAX_BYTES,
	});
	if (first.status !== "ok") return first;
	const parts: string[] = [];
	let current = first;
	let expectedStart = options.offset;
	let returnedSegments = 0;
	let returnedBytes = 0;
	let sourceQueryCount = 0;
	while (true) {
		const page = current.page;
		if (
			page.revision !== first.page.revision ||
			page.sourceSha256 !== first.page.sourceSha256 ||
			page.total !== first.page.total
		)
			throw new ElizaError("Message content changed during complete read", {
				code: "MESSAGE_CONTENT_STALE_REVISION",
			});
		const bytes = new TextEncoder().encode(page.text);
		if (
			!Number.isSafeInteger(page.start) ||
			!Number.isSafeInteger(page.end) ||
			!Number.isSafeInteger(page.total) ||
			page.start !== expectedStart ||
			page.start < 0 ||
			page.end < page.start ||
			page.end > page.total ||
			(page.end === page.start && page.end < page.total) ||
			bytes.length !== page.end - page.start ||
			createHash("sha256").update(bytes).digest("hex") !== page.sliceSha256
		)
			throw new ElizaError(
				"Message content pages are not complete and contiguous",
				{ code: "MESSAGE_CONTENT_CORRUPT" },
			);
		parts.push(page.text);
		returnedSegments += page.returnedSegments;
		returnedBytes += page.returnedBytes;
		sourceQueryCount += page.sourceQueryCount;
		if (page.end === page.total) {
			const text = parts.join("");
			const sliceSha256 = createHash("sha256").update(text).digest("hex");
			if (options.offset === 0 && sliceSha256 !== page.sourceSha256)
				throw new ElizaError(
					"Complete message content does not match its source digest",
					{ code: "MESSAGE_CONTENT_CORRUPT" },
				);
			return {
				...first,
				page: {
					...first.page,
					text,
					end: page.end,
					sliceSha256,
					returnedSegments,
					returnedBytes,
					sourceQueryCount,
				},
			};
		}
		expectedStart = page.end;
		const next = await readPage({
			offset: expectedStart,
			limit: MESSAGE_CONTENT_SEGMENT_MAX_BYTES,
			expectedRevision: first.page.revision,
		});
		if (next.status !== "ok")
			throw new ElizaError(
				"Message content became unavailable during complete read",
				{ code: "MESSAGE_CONTENT_UNAVAILABLE" },
			);
		current = next;
	}
}
