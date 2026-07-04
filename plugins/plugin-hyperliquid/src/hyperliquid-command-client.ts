/**
 * POST client for Hyperliquid command endpoints, backing the view-bundle
 * `interact` handler's `terminal-hyperliquid-execution-check` capability (POST
 * /api/hyperliquid/orders/open and siblings). Kept in its own dependency-light
 * module with no `@elizaos/ui`/view imports so it resolves and unit-tests in
 * isolation. Because these are market-mutation-adjacent execution requests,
 * response handling must fail closed: a truncated/unparseable body is a
 * provider failure, never a fabricated successful-execution result the
 * caller/model would trust.
 */

/**
 * POST a command to a Hyperliquid route and return the parsed JSON body.
 *
 * Fail-closed contract:
 * - Non-ok response with a parseable `{ error: string }` body -> throw that error.
 * - Non-ok response with an unparseable body -> throw a status error that names
 *   the unparseable body (the transport failure is not masked).
 * - Ok response with an unparseable body -> throw a distinct provider-failure
 *   error. It must NOT return a fabricated `{}` that the caller/model would read
 *   as a successful execution.
 */
export async function postHyperliquidCommand(
	path: string,
	body: Record<string, unknown>,
): Promise<unknown> {
	const response = await fetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	let parsed: unknown;
	let parseFailed = false;
	try {
		parsed = await response.json();
	} catch (cause) {
		// error-policy:J3 untrusted provider body — record the parse failure as an
		// explicit "invalid" signal instead of substituting a fake-valid {} object.
		parseFailed = true;
		parsed = undefined;
		if (!response.ok) {
			// non-ok + unparseable: surface a boundary failure that keeps the parse
			// cause so the transport failure is not masked by a bare status.
			throw new Error(
				`Hyperliquid request failed with ${response.status} (unparseable error body)`,
				{ cause },
			);
		}
	}
	if (!response.ok) {
		const message =
			typeof parsed === "object" &&
			parsed !== null &&
			"error" in parsed &&
			typeof (parsed as { error: unknown }).error === "string"
				? (parsed as { error: string }).error
				: `Hyperliquid request failed with ${response.status}`;
		throw new Error(message);
	}
	if (parseFailed) {
		// error-policy:J1 transport boundary — a 2xx with an unparseable body is a
		// provider failure on an execution-check path; fail closed rather than
		// returning a fabricated-success empty result the caller/model would trust.
		throw new Error(
			"Hyperliquid returned an unreadable response body for a market execution request",
		);
	}
	return parsed;
}
