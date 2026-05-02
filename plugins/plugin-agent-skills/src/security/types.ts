/**
 * Types for the skill security scanner.
 */

export type SkillScanSeverity = "info" | "warn" | "critical";

export interface SkillScanFinding {
	ruleId: string;
	severity: SkillScanSeverity;
	file: string;
	line: number;
	message: string;
	evidence: string;
}

export interface ManifestFinding {
	ruleId: string;
	severity: SkillScanSeverity;
	file: string;
	message: string;
}

/**
 * - "clean": No findings.
 * - "warning": Warn-level findings; enable after acknowledgment.
 * - "critical": Critical findings; enable after explicit acknowledgment.
 * - "blocked": Binary/symlink/missing SKILL.md; cannot be enabled.
 */
export type SkillScanStatus = "clean" | "warning" | "critical" | "blocked";

export interface SkillScanReport {
	scannedAt: string;
	status: SkillScanStatus;
	summary: {
		scannedFiles: number;
		critical: number;
		warn: number;
		info: number;
	};
	findings: SkillScanFinding[];
	manifestFindings: ManifestFinding[];
	skillPath: string;
}

export interface SkillScanOptions {
	maxFiles?: number;
	maxFileBytes?: number;
	additionalSafeDomains?: string[];
}

export function truncateEvidence(evidence: string, maxLen = 120): string {
	if (evidence.length <= maxLen) return evidence;
	return `${evidence.slice(0, maxLen)}…`;
}

/** Line-level rule: matches per-line, fires at most once per file. */
export interface LineRule {
	ruleId: string;
	severity: SkillScanSeverity;
	message: string;
	pattern: RegExp;
	/** Only fires when the full source also matches this pattern. */
	requiresContext?: RegExp;
}

/** Source-level rule: matches against the full file content. */
export interface SourceRule {
	ruleId: string;
	severity: SkillScanSeverity;
	message: string;
	pattern: RegExp;
	requiresContext?: RegExp;
}
