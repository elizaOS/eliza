/**
 * Connector setup-routes contract test.
 *
 * This test pins the intended shared shape for connector setup routes.
 * Today most connectors diverge — see docs/onboarding-contracts.md §5.
 * Normalization is tracked as a follow-up; failures here are expected
 * for now and use `test.fails(...)` so the suite produces useful signal
 * without blocking CI.
 *
 * The contract every connector plugin's setup-routes export MUST satisfy:
 *
 *   1. Path prefix is `/api/setup/<connector-name>/` — uniform, predictable.
 *   2. There is a `GET /api/setup/<connector-name>/status` endpoint that
 *      returns `{ connector: string, state: 'idle'|'configuring'|'paired'|'error',
 *      detail?: string }`. (Response shape is exercised at runtime, not here.)
 *   3. There is a `POST /api/setup/<connector-name>/start` that accepts the
 *      connector-specific config payload and transitions state to 'configuring'.
 *   4. There is a `POST /api/setup/<connector-name>/cancel` that returns state
 *      to 'idle'.
 *   5. Error responses follow `{ error: { code, message } }` — no bare strings.
 *      (Static analysis of error shapes is checked here as a best-effort
 *      grep for bare `error: "..."` literals.)
 *
 * The test reads each connector's setup-routes source file as text and extracts
 * the route entries via a minimal parser. This keeps the test side-effect-free
 * (no need to actually import + execute the plugin code) and gives the
 * normalization follow-up a precise spec to satisfy.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";

// ── Connector inventory ────────────────────────────────────────────────────

interface ConnectorTarget {
	/** Slug used in the intended `/api/setup/<name>/` path. */
	connector: string;
	/** Repo-relative path to the setup-routes source file. */
	file: string;
	/** Expected name of the `Route[]` export. */
	exportName: string;
}

const REPO_ROOT = path.resolve(__dirname, "..", "..");

const CONNECTORS: ConnectorTarget[] = [
	{
		connector: "discord",
		file: "plugins/plugin-discord/setup-routes.ts",
		exportName: "discordSetupRoutes",
	},
	{
		connector: "telegram",
		file: "plugins/plugin-telegram/src/setup-routes.ts",
		exportName: "telegramSetupRoutes",
	},
	{
		connector: "signal",
		file: "plugins/plugin-signal/src/setup-routes.ts",
		exportName: "signalSetupRoutes",
	},
	{
		connector: "imessage",
		file: "plugins/plugin-imessage/src/setup-routes.ts",
		exportName: "imessageSetupRoutes",
	},
	{
		connector: "bluebubbles",
		file: "plugins/plugin-bluebubbles/src/setup-routes.ts",
		exportName: "blueBubblesSetupRoutes",
	},
	{
		connector: "documents",
		file: "plugins/app-documents/src/setup-routes.ts",
		exportName: "documentsRoutes",
	},
];

// ── Source parsing ─────────────────────────────────────────────────────────

interface ParsedRoute {
	type: string;
	path: string;
}

interface ParsedExport {
	source: string;
	routes: ParsedRoute[];
	hasBareErrorString: boolean;
}

/**
 * Extract route entries from the `Route[]` export. Looks for the array
 * literal assigned to `export const <exportName>` (or in app-documents'
 * case, an `.map(...)` derived array — handled separately) and pulls
 * out each `{ type: "X", path: "Y" }` object.
 *
 * This is deliberately a regex-based parser, not a real AST walk: it
 * keeps the test self-contained and the contract surface is simple
 * enough that string scanning is sufficient.
 */
function parseExport(
	source: string,
	exportName: string,
): ParsedExport | null {
	const arrayDeclMatch = source.match(
		new RegExp(`export\\s+const\\s+${exportName}\\s*:[^=]*=\\s*([\\s\\S]*?);\\s*(?:\\n|$)`),
	);
	if (!arrayDeclMatch) return null;
	const body = arrayDeclMatch[1];

	const routes: ParsedRoute[] = [];

	// Direct array literal form: [{ type: "GET", path: "/x", ... }, ...]
	const entryRegex =
		/\{\s*type:\s*"(GET|POST|PUT|PATCH|DELETE|STATIC)"\s*,\s*path:\s*"([^"]+)"/g;
	let match: RegExpExecArray | null;
	while ((match = entryRegex.exec(body)) !== null) {
		routes.push({ type: match[1], path: match[2] });
	}

	// app-documents declares routes by mapping over a DOCUMENT_ROUTES list.
	// Pick those up too when the export is derived via `.map(...)`.
	if (routes.length === 0) {
		const tableRegex =
			/\{\s*type:\s*"(GET|POST|PUT|PATCH|DELETE|STATIC)"\s*,\s*path:\s*"([^"]+)"\s*\}/g;
		while ((match = tableRegex.exec(source)) !== null) {
			routes.push({ type: match[1], path: match[2] });
		}
	}

	// Best-effort scan for bare `error: <string>` literal in response bodies —
	// the contract requires `{ error: { code, message } }` instead.
	// Matches `error: "..."`, `error: \`...\``, `error: '...'`, and the
	// common template-string form `error: \`...${err}\`` plus
	// `error: result.error ?? "..."`. Any of these indicates a flat-string
	// error response shape rather than a structured envelope.
	const bareErrorPatterns = [
		/\berror:\s*["`'][^"`']/,
		/\berror:\s*`/,
		/\berror:\s*\(err as Error\)\.message/,
		/\berror:\s*result\.error/,
		/\berror:\s*String\(/,
		/\berror:\s*\w+\s*\?\?\s*["'`]/,
		// Helpers that emit a flat `{ error: "..." }` response.
		/\bsendJsonError\s*\(/,
		/\bhttpSendJsonError\s*\(/,
		/\bwriteJsonError\b/,
	];
	const hasBareErrorString = bareErrorPatterns.some((rx) => rx.test(source));

	return { source, routes, hasBareErrorString };
}

function loadConnector(target: ConnectorTarget): ParsedExport | null {
	const absPath = path.join(REPO_ROOT, target.file);
	if (!existsSync(absPath)) return null;
	const source = readFileSync(absPath, "utf8");
	return parseExport(source, target.exportName);
}

// ── Contract assertions ────────────────────────────────────────────────────

interface ComplianceRecord {
	connector: string;
	checks: Record<string, boolean>;
	score: number;
	max: number;
}

const compliance: ComplianceRecord[] = [];

function record(
	connector: string,
	check: string,
	pass: boolean,
): void {
	let entry = compliance.find((c) => c.connector === connector);
	if (!entry) {
		entry = { connector, checks: {}, score: 0, max: 0 };
		compliance.push(entry);
	}
	entry.checks[check] = pass;
	entry.max += 1;
	if (pass) entry.score += 1;
}

for (const target of CONNECTORS) {
	describe(`connector: ${target.connector}`, () => {
		const parsed = loadConnector(target);

		test("setup-routes source file exists", () => {
			expect(parsed, `missing ${target.file}`).not.toBeNull();
			record(target.connector, "file_exists", parsed !== null);
		});

		if (!parsed) return;

		test(`exports a non-empty Route[] as ${target.exportName}`, () => {
			expect(parsed.routes.length, "no routes parsed from export").toBeGreaterThan(0);
			record(target.connector, "routes_parsed", parsed.routes.length > 0);
		});

		// ── Contract rule 1: path prefix `/api/setup/<connector>/`
		test.fails(
			`all routes use prefix /api/setup/${target.connector}/`,
			() => {
				const expectedPrefix = `/api/setup/${target.connector}/`;
				const offending = parsed.routes.filter(
					(r) => !r.path.startsWith(expectedPrefix),
				);
				const pass = offending.length === 0;
				record(target.connector, "path_prefix", pass);
				expect(offending, `routes not under ${expectedPrefix}`).toEqual([]);
			},
		);

		// ── Contract rule 2: GET /api/setup/<connector>/status
		test.fails(
			`exposes GET /api/setup/${target.connector}/status`,
			() => {
				const target_path = `/api/setup/${target.connector}/status`;
				const found = parsed.routes.some(
					(r) => r.type === "GET" && r.path === target_path,
				);
				record(target.connector, "status_endpoint", found);
				expect(found, `missing GET ${target_path}`).toBe(true);
			},
		);

		// ── Contract rule 3: POST /api/setup/<connector>/start
		test.fails(
			`exposes POST /api/setup/${target.connector}/start`,
			() => {
				const target_path = `/api/setup/${target.connector}/start`;
				const found = parsed.routes.some(
					(r) => r.type === "POST" && r.path === target_path,
				);
				record(target.connector, "start_endpoint", found);
				expect(found, `missing POST ${target_path}`).toBe(true);
			},
		);

		// ── Contract rule 4: POST /api/setup/<connector>/cancel
		test.fails(
			`exposes POST /api/setup/${target.connector}/cancel`,
			() => {
				const target_path = `/api/setup/${target.connector}/cancel`;
				const found = parsed.routes.some(
					(r) => r.type === "POST" && r.path === target_path,
				);
				record(target.connector, "cancel_endpoint", found);
				expect(found, `missing POST ${target_path}`).toBe(true);
			},
		);

		// ── Contract rule 5: error responses use { error: { code, message } }
		test.fails(
			"error responses use structured { error: { code, message } } envelope",
			() => {
				record(target.connector, "structured_errors", !parsed.hasBareErrorString);
				expect(
					parsed.hasBareErrorString,
					"found bare `error: \"string\"` in responses",
				).toBe(false);
			},
		);
	});
}

// ── Final summary ──────────────────────────────────────────────────────────

afterAll(() => {
	const allChecks = ["file_exists", "routes_parsed", "path_prefix", "status_endpoint", "start_endpoint", "cancel_endpoint", "structured_errors"];

	const header = ["connector", ...allChecks, "%"];
	const colWidths = header.map((h) => h.length);

	const rows: string[][] = [];
	for (const entry of compliance) {
		const pct = entry.max > 0 ? Math.round((entry.score / entry.max) * 100) : 0;
		const row = [
			entry.connector,
			...allChecks.map((check) => {
				if (!(check in entry.checks)) return "-";
				return entry.checks[check] ? "PASS" : "FAIL";
			}),
			`${pct}%`,
		];
		row.forEach((cell, i) => {
			if (cell.length > colWidths[i]) colWidths[i] = cell.length;
		});
		rows.push(row);
	}

	const pad = (cell: string, w: number) => cell.padEnd(w, " ");
	const fmtRow = (row: string[]) =>
		row.map((c, i) => pad(c, colWidths[i])).join("  ");

	console.log("\n=== Connector setup-routes contract compliance ===");
	console.log(fmtRow(header));
	console.log(colWidths.map((w) => "-".repeat(w)).join("  "));
	for (const row of rows) {
		console.log(fmtRow(row));
	}

	const totalScore = compliance.reduce((sum, c) => sum + c.score, 0);
	const totalMax = compliance.reduce((sum, c) => sum + c.max, 0);
	const overall = totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : 0;
	console.log(
		`\nOverall compliance: ${totalScore}/${totalMax} (${overall}%)`,
	);
	console.log(
		"Note: failing rule checks above are expected (test.fails) until normalization lands.",
	);
});
