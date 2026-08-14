/**
 * Unit coverage for the tool-call diagnostic projection: composed
 * runtime-known + shape redaction, key-based masking, primitive
 * preservation, non-mutation, structural sharing, and cycle/depth bounds.
 * Deterministic and fully synthetic — every credential-shaped value is an
 * obviously fake canary, never a real secret.
 */

import { describe, expect, it } from "vitest";
import {
	composeToolDiagnosticRedactor,
	projectToolDiagnosticArgs,
	projectToolDiagnosticValue,
	TOOL_DIAGNOSTIC_MASK,
} from "./tool-diagnostics";

const RUNTIME_SECRET_CANARY = "SYNTH-RUNTIME-SECRET-CANARY-0000";
const FLAG_CANARY = "SYNTH-FLAG-CANARY-1111";
const USERINFO_CANARY = "SYNTH-URI-CANARY-2222";

const redactor = composeToolDiagnosticRedactor({
	redactSecrets: (text) =>
		text.split(RUNTIME_SECRET_CANARY).join("[REDACTED:CANARY]"),
});

describe("composeToolDiagnosticRedactor", () => {
	it("applies runtime-known-secret redaction before shape patterns", () => {
		const projected = redactor(
			`run with ${RUNTIME_SECRET_CANARY} and --token=${FLAG_CANARY}`,
		);
		expect(projected).not.toContain(RUNTIME_SECRET_CANARY);
		expect(projected).not.toContain(FLAG_CANARY);
		expect(projected).toContain("[REDACTED:CANARY]");
	});

	it("keeps the shape pass when redactSecrets is identity", () => {
		const identity = composeToolDiagnosticRedactor({
			redactSecrets: (text) => text,
		});
		expect(identity(`--token=${FLAG_CANARY}`)).not.toContain(FLAG_CANARY);
	});

	it("masks URI userinfo credentials", () => {
		const projected = redactor(
			`https://user:${USERINFO_CANARY}@internal.example/path`,
		);
		expect(projected).not.toContain(USERINFO_CANARY);
		expect(projected).toContain("https://***@internal.example/path");
	});
});

describe("projectToolDiagnosticValue", () => {
	it("preserves numbers, booleans, and null exactly", () => {
		const args = {
			retries: 3,
			ratio: 0.25,
			dryRun: false,
			enabled: true,
			cursor: null,
		};
		expect(projectToolDiagnosticValue(args, redactor)).toEqual(args);
	});

	it("fully masks values under credential-named keys", () => {
		const projected = projectToolDiagnosticValue(
			{ apiKey: "short", nested: { authorization: { deep: 1 } } },
			redactor,
		) as Record<string, unknown>;
		expect(projected.apiKey).toBe(TOOL_DIAGNOSTIC_MASK);
		expect((projected.nested as Record<string, unknown>).authorization).toBe(
			TOOL_DIAGNOSTIC_MASK,
		);
	});

	it("scrubs nested strings without mutating the input", () => {
		const raw = {
			command: `deploy --token=${FLAG_CANARY}`,
			targets: [`https://ci:${USERINFO_CANARY}@ci.example/job`],
		};
		const projected = projectToolDiagnosticValue(raw, redactor) as typeof raw;
		expect(projected).not.toBe(raw);
		expect(JSON.stringify(projected)).not.toContain(FLAG_CANARY);
		expect(JSON.stringify(projected)).not.toContain(USERINFO_CANARY);
		expect(raw.command).toContain(FLAG_CANARY);
		expect(raw.targets[0]).toContain(USERINFO_CANARY);
	});

	it("returns the same reference when nothing needs redaction", () => {
		const raw = { path: "/tmp/file.txt", lines: [1, 2, 3], deep: { ok: true } };
		expect(projectToolDiagnosticValue(raw, redactor)).toBe(raw);
	});

	it("collapses cycles to the mask instead of hanging", () => {
		const raw: Record<string, unknown> = { name: "loop" };
		raw.self = raw;
		const projected = projectToolDiagnosticValue(raw, redactor) as Record<
			string,
			unknown
		>;
		expect(projected.self).toBe(TOOL_DIAGNOSTIC_MASK);
		expect(projected.name).toBe("loop");
	});

	it("allows the same subtree on sibling paths (DAG, not cycle)", () => {
		const shared = { ok: true };
		const projected = projectToolDiagnosticValue(
			{ a: shared, b: shared },
			redactor,
		) as Record<string, unknown>;
		expect(projected.a).toEqual({ ok: true });
		expect(projected.b).toEqual({ ok: true });
	});

	it("bounds depth", () => {
		let deep: Record<string, unknown> = { leaf: `--token=${FLAG_CANARY}` };
		for (let i = 0; i < 12; i += 1) {
			deep = { child: deep };
		}
		const serialized = JSON.stringify(
			projectToolDiagnosticValue(deep, redactor),
		);
		expect(serialized).not.toContain(FLAG_CANARY);
		expect(serialized).toContain(TOOL_DIAGNOSTIC_MASK);
	});

	it("scrubs Error message and stack while preserving the shape", () => {
		const raw = new Error(`refused --token=${FLAG_CANARY}`);
		raw.name = "ToolFailure";
		const projected = projectToolDiagnosticValue(raw, redactor) as Error;
		expect(projected).toBeInstanceOf(Error);
		expect(projected.name).toBe("ToolFailure");
		expect(projected.message).not.toContain(FLAG_CANARY);
		expect(projected.stack ?? "").not.toContain(FLAG_CANARY);
	});
});

describe("projectToolDiagnosticArgs", () => {
	it("passes undefined through", () => {
		expect(projectToolDiagnosticArgs(undefined, redactor)).toBeUndefined();
	});

	it("projects a defined record", () => {
		const projected = projectToolDiagnosticArgs(
			{ token: FLAG_CANARY, count: 2 },
			redactor,
		);
		expect(projected?.token).toBe(TOOL_DIAGNOSTIC_MASK);
		expect(projected?.count).toBe(2);
	});
});
