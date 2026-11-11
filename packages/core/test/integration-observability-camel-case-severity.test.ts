/**
 * Regression: camelCase error names must classify as the expected lifeops
 * fallback paths in the default integration severity policy.
 *
 * `defaultIntegrationSeverityPolicy` treats `runtime_unavailable`,
 * `lifeops_storage_unavailable` and `lifeops_auth_invalid` on the lifeops
 * boundary as expected failures (info). `sanitizeToken` lowercased
 * camelCase error names without inserting word separators, so an Error named
 * `RuntimeUnavailable` produced `runtimeunavailable`, never matched the
 * policy, and was logged at warn.
 */

import { describe, expect, it } from "vitest";
import {
	createIntegrationTelemetrySpan,
	type IntegrationLogger,
} from "../src/integration-observability";

function captureSink() {
	const lines: { level: "info" | "warn"; line: string }[] = [];
	const sink: IntegrationLogger = {
		info: (line) => lines.push({ level: "info", line }),
		warn: (line) => lines.push({ level: "warn", line }),
	};
	return { sink, lines };
}

function namedError(name: string): Error {
	const error = new Error("fallback");
	error.name = name;
	return error;
}

function failureLevel(
	boundary: "lifeops" | "marketplace",
	error: unknown,
	errorKind?: string,
): { level: "info" | "warn"; event: Record<string, unknown> } {
	const { sink, lines } = captureSink();
	const span = createIntegrationTelemetrySpan(
		{ boundary, operation: "test-op" },
		{ sink, now: () => 1000 },
	);
	span.failure(errorKind !== undefined ? { errorKind } : { error });
	expect(lines).toHaveLength(1);
	const entry = lines[0];
	if (!entry) throw new Error("expected one telemetry line");
	const json = entry.line.slice(entry.line.indexOf("{"));
	return {
		level: entry.level,
		event: JSON.parse(json) as Record<string, unknown>,
	};
}

describe("integration observability camelCase error kinds", () => {
	it.each([
		["RuntimeUnavailable", "runtime_unavailable"],
		["LifeopsStorageUnavailable", "lifeops_storage_unavailable"],
		["LifeopsAuthInvalid", "lifeops_auth_invalid"],
	])(
		"logs a lifeops %s failure at info with errorKind %s",
		(name, expectedKind) => {
			const { level, event } = failureLevel("lifeops", namedError(name));
			expect(event.errorKind).toBe(expectedKind);
			expect(level).toBe("info");
		},
	);

	it("still logs a caller-supplied snake_case errorKind at info", () => {
		const { level, event } = failureLevel(
			"lifeops",
			undefined,
			"runtime_unavailable",
		);
		expect(event.errorKind).toBe("runtime_unavailable");
		expect(level).toBe("info");
	});

	it("still logs an unexpected lifeops failure at warn", () => {
		const { level, event } = failureLevel("lifeops", namedError("TypeError"));
		expect(event.errorKind).toBe("type_error");
		expect(level).toBe("warn");
	});
});
