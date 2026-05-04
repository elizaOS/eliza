/**
 * Skill Security Scanner — entry point.
 *
 * Usage:
 *   const report = await scanSkillDirectory("/path/to/skill");
 *   if (report.status === "blocked") { ... }
 */

import {
	buildManifestEntriesFromDisk,
	buildManifestEntriesFromMemory,
	scanManifest,
} from "./manifest-scanner";
import { isMarkdown, scanMarkdownSource } from "./markdown-scanner";
import { isScannableCode, scanCodeSource } from "./skill-scanner";
import type {
	SkillScanFinding,
	SkillScanOptions,
	SkillScanReport,
	SkillScanStatus,
} from "./types";

export type { ManifestFileEntry } from "./manifest-scanner";
export {
	buildManifestEntriesFromDisk,
	buildManifestEntriesFromMemory,
	scanManifest,
} from "./manifest-scanner";
export { isMarkdown, scanMarkdownSource } from "./markdown-scanner";
export { isScannableCode, scanCodeSource } from "./skill-scanner";
export type {
	ManifestFinding,
	SkillScanFinding,
	SkillScanOptions,
	SkillScanReport,
	SkillScanSeverity,
	SkillScanStatus,
} from "./types";

const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

export const SCAN_REPORT_FILENAME = ".scan-results.json";

const BLOCKING_RULE_IDS = new Set([
	"binary-file",
	"symlink-escape",
	"missing-skill-md",
]);

function buildReport(
	skillPath: string,
	scannedFiles: number,
	findings: SkillScanFinding[],
	manifestFindings: ManifestFinding[],
): SkillScanReport {
	let critical = 0,
		warn = 0,
		info = 0,
		hasBlocking = false;

	for (const f of findings) {
		if (f.severity === "critical") critical++;
		else if (f.severity === "warn") warn++;
		else info++;
	}
	for (const f of manifestFindings) {
		if (BLOCKING_RULE_IDS.has(f.ruleId)) hasBlocking = true;
		if (f.severity === "critical") critical++;
		else if (f.severity === "warn") warn++;
		else info++;
	}

	let status: SkillScanStatus;
	if (hasBlocking) status = "blocked";
	else if (critical > 0) status = "critical";
	else if (warn > 0) status = "warning";
	else status = "clean";

	return {
		scannedAt: new Date().toISOString(),
		status,
		summary: { scannedFiles, critical, warn, info },
		findings,
		manifestFindings,
		skillPath,
	};
}

// Need the import for buildReport's parameter type
import type { ManifestFinding } from "./types";

export async function scanSkillDirectory(
	dirPath: string,
	options: SkillScanOptions = {},
): Promise<SkillScanReport> {
	const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
	const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
	const safeDomains = options.additionalSafeDomains ?? [];

	const fs = await import("node:fs/promises");
	const path = await import("node:path");

	const manifestEntries = await buildManifestEntriesFromDisk(dirPath);
	const manifestFindings = scanManifest(manifestEntries, dirPath);

	const allFindings: SkillScanFinding[] = [];
	let scannedCount = 0;

	for (const entry of manifestEntries) {
		if (scannedCount >= maxFiles) break;
		if (entry.isSymlink || entry.sizeBytes > maxFileBytes) continue;

		const isCode = isScannableCode(entry.relativePath);
		const isMd = isMarkdown(entry.relativePath);
		if (!isCode && !isMd) continue;

		let content: string;
		try {
			content = await fs.readFile(
				path.join(dirPath, entry.relativePath),
				"utf-8",
			);
		} catch {
			continue;
		}

		scannedCount++;
		if (isCode)
			allFindings.push(...scanCodeSource(content, entry.relativePath));
		if (isMd)
			allFindings.push(
				...scanMarkdownSource(content, entry.relativePath, safeDomains),
			);
	}

	return buildReport(dirPath, scannedCount, allFindings, manifestFindings);
}

export function scanSkillPackage(
	files: Map<string, { content: string | Uint8Array; isText: boolean }>,
	skillPath: string,
	options: SkillScanOptions = {},
): SkillScanReport {
	const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
	const safeDomains = options.additionalSafeDomains ?? [];

	const manifestEntries = buildManifestEntriesFromMemory(files);
	const manifestFindings = scanManifest(manifestEntries, skillPath);

	const allFindings: SkillScanFinding[] = [];
	let scannedCount = 0;

	for (const [relativePath, file] of files) {
		if (scannedCount >= maxFiles || !file.isText) continue;

		const isCode = isScannableCode(relativePath);
		const isMd = isMarkdown(relativePath);
		if (!isCode && !isMd) continue;

		scannedCount++;
		const content = file.content as string;
		if (isCode) allFindings.push(...scanCodeSource(content, relativePath));
		if (isMd)
			allFindings.push(
				...scanMarkdownSource(content, relativePath, safeDomains),
			);
	}

	return buildReport(skillPath, scannedCount, allFindings, manifestFindings);
}

export async function saveScanReport(
	skillDirPath: string,
	report: SkillScanReport,
): Promise<void> {
	const fs = await import("node:fs/promises");
	const path = await import("node:path");
	await fs.writeFile(
		path.join(skillDirPath, SCAN_REPORT_FILENAME),
		JSON.stringify(report, null, 2),
		"utf-8",
	);
}

export async function loadScanReport(
	skillDirPath: string,
): Promise<SkillScanReport | null> {
	const fs = await import("node:fs/promises");
	const path = await import("node:path");
	try {
		const content = await fs.readFile(
			path.join(skillDirPath, SCAN_REPORT_FILENAME),
			"utf-8",
		);
		const parsed = JSON.parse(content) as SkillScanReport;
		if (
			typeof parsed.scannedAt !== "string" ||
			!Array.isArray(parsed.findings) ||
			!Array.isArray(parsed.manifestFindings)
		)
			return null;
		return parsed;
	} catch {
		return null;
	}
}
