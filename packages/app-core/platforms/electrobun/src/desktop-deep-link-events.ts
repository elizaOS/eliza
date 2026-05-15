export function readOpenUrlEventUrl(event: unknown): string | null {
	if (typeof event === "string") {
		const url = event.trim();
		return url.length > 0 ? url : null;
	}
	if (!event || typeof event !== "object") return null;

	const record = event as {
		url?: unknown;
		data?: { url?: unknown };
	};
	const rawUrl = typeof record.url === "string" ? record.url : record.data?.url;
	if (typeof rawUrl !== "string") return null;

	const url = rawUrl.trim();
	return url.length > 0 ? url : null;
}
