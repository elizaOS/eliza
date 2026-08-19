/**
 * Bounded install-download reader for Agent Skills packages.
 * Cancels the response stream as soon as {@link MAX_SKILL_PACKAGE_BYTES} is
 * exceeded so a lying or missing Content-Length cannot force an unbounded
 * `arrayBuffer()` / `text()` allocation.
 */

/** Maximum zip / SKILL.md download size (10MB). */
export const MAX_SKILL_PACKAGE_BYTES = 10 * 1024 * 1024;

/**
 * Read a skill install body under {@link MAX_SKILL_PACKAGE_BYTES}.
 * Throws `Package too large (max 10MB)` once the running total exceeds the cap.
 */
export async function readCappedSkillPackage(
	response: Response,
): Promise<Uint8Array> {
	const tooLarge = (): Error =>
		new Error(
			`Package too large (max ${MAX_SKILL_PACKAGE_BYTES / 1024 / 1024}MB)`,
		);
	const body = response.body;
	if (!body) {
		const fallback = new Uint8Array(await response.arrayBuffer());
		if (fallback.byteLength > MAX_SKILL_PACKAGE_BYTES) {
			throw tooLarge();
		}
		return fallback;
	}
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value?.byteLength) continue;
			total += value.byteLength;
			if (total > MAX_SKILL_PACKAGE_BYTES) {
				try {
					await reader.cancel();
				} catch {
					// error-policy:J6 cancel is best-effort after the byte-cap failure.
				}
				throw tooLarge();
			}
			chunks.push(value);
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// error-policy:J6 stream lock release is teardown-only.
		}
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/** Decode a capped install download as UTF-8 text (SKILL.md / README.md). */
export async function readCappedSkillText(
	response: Response,
): Promise<string> {
	return new TextDecoder().decode(await readCappedSkillPackage(response));
}
