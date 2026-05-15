/**
 * WS3 publishing-pipeline test for `ELIZA_1_BUNDLE_EXTRAS.json#imagegen`.
 *
 * Every imagegen entry (per-tier `default` + every `optional`) must
 * declare its publishing state. The validator (eliza/scripts/
 * validate-bundle-plan.mjs) already enforces this on every CI run; this
 * test guards the same invariant from inside the runtime test suite so
 * a regression that lands while the validator isn't wired into the
 * matrix still fails fast.
 *
 * Each entry must carry one of:
 *
 *   - `url`: an HTTPS URL pointing at the runtime download target. The
 *     installer fetches the file from this URL at first-use. Optional
 *     `sha256` (64-char hex) lets the installer verify after download.
 *   - `staged: true` and a `buildPlan` block with `tool`, `source`, and
 *     `command`. Staged entries are documented build steps for artifacts
 *     that aren't yet hosted; the installer skips them and the runtime
 *     surfaces "build pending" in the UI.
 *
 * Both fields together is ambiguous and rejected.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const EXTRAS_PATH = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"docs",
	"ELIZA_1_BUNDLE_EXTRAS.json",
);

interface ImageGenEntry {
	id: string;
	file: string;
	estimatedSizeBytes: number;
	license: string;
	url?: string;
	sha256?: string;
	staged?: boolean;
	buildPlan?: { tool?: unknown; source?: unknown; command?: unknown };
}

interface ExtrasShape {
	imagegen: {
		perTier: Record<
			string,
			{
				default: ImageGenEntry;
				optional: ImageGenEntry[];
			}
		>;
	};
}

function loadExtras(): ExtrasShape {
	const raw = fs.readFileSync(EXTRAS_PATH, "utf8");
	return JSON.parse(raw) as ExtrasShape;
}

function isHttpsUrl(value: unknown): value is string {
	if (typeof value !== "string") return false;
	return /^https:\/\/.+/i.test(value.trim());
}

function isHexSha256(value: unknown): boolean {
	return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value.trim());
}

describe("WS3 imagegen publishing pipeline", () => {
	it("every per-tier default has a url OR a staged buildPlan", () => {
		const extras = loadExtras();
		const failures: string[] = [];
		for (const [tierId, perTier] of Object.entries(
			extras.imagegen.perTier,
		)) {
			const entry = perTier.default;
			const where = `imagegen.perTier.${tierId}.default (${entry.id})`;
			const hasUrl = isHttpsUrl(entry.url);
			const isStaged = entry.staged === true;
			if (hasUrl && isStaged) {
				failures.push(
					`${where}: ambiguous — both staged:true AND url set`,
				);
				continue;
			}
			if (!hasUrl && !isStaged) {
				failures.push(
					`${where}: missing publishing state — needs url (https://) or staged:true + buildPlan`,
				);
				continue;
			}
			if (isStaged) {
				const plan = entry.buildPlan;
				if (
					!plan ||
					typeof plan.tool !== "string" ||
					typeof plan.source !== "string" ||
					typeof plan.command !== "string"
				) {
					failures.push(
						`${where}: staged entry missing buildPlan.{tool,source,command}`,
					);
				}
			}
		}
		expect(failures, failures.join("\n")).toHaveLength(0);
	});

	it("every optional entry has a url OR a staged buildPlan", () => {
		const extras = loadExtras();
		const failures: string[] = [];
		for (const [tierId, perTier] of Object.entries(
			extras.imagegen.perTier,
		)) {
			for (let i = 0; i < perTier.optional.length; i += 1) {
				const entry = perTier.optional[i];
				const where = `imagegen.perTier.${tierId}.optional[${i}] (${entry?.id})`;
				const hasUrl = isHttpsUrl(entry?.url);
				const isStaged = entry?.staged === true;
				if (hasUrl && isStaged) {
					failures.push(
						`${where}: ambiguous — both staged:true AND url set`,
					);
					continue;
				}
				if (!hasUrl && !isStaged) {
					failures.push(
						`${where}: missing publishing state — needs url (https://) or staged:true + buildPlan`,
					);
					continue;
				}
				if (isStaged) {
					const plan = entry.buildPlan;
					if (
						!plan ||
						typeof plan.tool !== "string" ||
						typeof plan.source !== "string" ||
						typeof plan.command !== "string"
					) {
						failures.push(
							`${where}: staged entry missing buildPlan.{tool,source,command}`,
						);
					}
				}
			}
		}
		expect(failures, failures.join("\n")).toHaveLength(0);
	});

	it("optional sha256 fields, when present, are 64-char hex digests", () => {
		const extras = loadExtras();
		const failures: string[] = [];
		const walk = (where: string, entry: ImageGenEntry) => {
			if (entry.sha256 !== undefined && !isHexSha256(entry.sha256)) {
				failures.push(
					`${where}: sha256 is set but not a 64-char hex digest`,
				);
			}
		};
		for (const [tierId, perTier] of Object.entries(
			extras.imagegen.perTier,
		)) {
			walk(
				`imagegen.perTier.${tierId}.default (${perTier.default.id})`,
				perTier.default,
			);
			for (let i = 0; i < perTier.optional.length; i += 1) {
				walk(
					`imagegen.perTier.${tierId}.optional[${i}] (${perTier.optional[i]?.id ?? "<no id>"})`,
					perTier.optional[i],
				);
			}
		}
		expect(failures, failures.join("\n")).toHaveLength(0);
	});

	it("staged buildPlans point at a real source URL", () => {
		// Tightening: tool/source/command must be non-empty strings, and
		// the `source` for a staged entry must be an https URL the build
		// step can fetch from.
		const extras = loadExtras();
		const failures: string[] = [];
		for (const [tierId, perTier] of Object.entries(
			extras.imagegen.perTier,
		)) {
			const candidates: { where: string; entry: ImageGenEntry }[] = [
				{
					where: `imagegen.perTier.${tierId}.default`,
					entry: perTier.default,
				},
				...perTier.optional.map((entry, i) => ({
					where: `imagegen.perTier.${tierId}.optional[${i}]`,
					entry,
				})),
			];
			for (const { where, entry } of candidates) {
				if (entry.staged !== true) continue;
				const plan = entry.buildPlan ?? {};
				if (
					typeof plan.source !== "string" ||
					!/^https:\/\//i.test(plan.source.trim())
				) {
					failures.push(
						`${where}: staged buildPlan.source must be an https:// URL`,
					);
				}
				if (typeof plan.command !== "string" || !plan.command.trim()) {
					failures.push(
						`${where}: staged buildPlan.command must be non-empty`,
					);
				}
				if (typeof plan.tool !== "string" || !plan.tool.trim()) {
					failures.push(
						`${where}: staged buildPlan.tool must be non-empty`,
					);
				}
			}
		}
		expect(failures, failures.join("\n")).toHaveLength(0);
	});

	it("every catalog imagegen tier appears in the bundle extras", () => {
		// Cross-check parity with `TIER_TO_DEFAULT_IMAGE_MODEL` in
		// services/imagegen/backend-selector.ts. Both maps must list the
		// same tier set, otherwise the provider's resolveImageGenModelKey
		// path can hand back a model id that has no bundle entry.
		const extras = loadExtras();
		const expectedTiers = [
			"eliza-1-0_8b",
			"eliza-1-2b",
			"eliza-1-4b",
			"eliza-1-9b",
			"eliza-1-27b",
			"eliza-1-27b-256k",
		];
		for (const tierId of expectedTiers) {
			expect(
				extras.imagegen.perTier[tierId],
				`tier "${tierId}" missing from ELIZA_1_BUNDLE_EXTRAS.json#imagegen.perTier`,
			).toBeDefined();
		}
	});
});
