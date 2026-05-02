/**
 * Code scanner — checks JS/TS files for dangerous runtime patterns.
 * Adapted from openclaw/src/security/skill-scanner.ts.
 */

import type { LineRule, SkillScanFinding, SourceRule } from "./types";
import { truncateEvidence } from "./types";

const SCANNABLE_EXTENSIONS = new Set([
	".js",
	".ts",
	".mjs",
	".cjs",
	".mts",
	".cts",
	".jsx",
	".tsx",
]);

export function isScannableCode(filePath: string): boolean {
	const dotIndex = filePath.lastIndexOf(".");
	if (dotIndex < 0) return false;
	return SCANNABLE_EXTENSIONS.has(filePath.slice(dotIndex).toLowerCase());
}

const LINE_RULES: LineRule[] = [
	{
		ruleId: "dangerous-exec",
		severity: "critical",
		message: "Shell command execution detected (child_process)",
		pattern: /\b(exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\(/,
		requiresContext: /child_process/,
	},
	{
		ruleId: "dynamic-code-execution",
		severity: "critical",
		message: "Dynamic code execution detected (eval or new Function)",
		pattern: /\beval\s*\(|new\s+Function\s*\(/,
	},
	{
		ruleId: "crypto-mining",
		severity: "critical",
		message: "Possible crypto-mining reference detected",
		pattern: /stratum\+tcp|stratum\+ssl|coinhive|cryptonight|xmrig/i,
	},
	{
		ruleId: "suspicious-network",
		severity: "warn",
		message: "WebSocket connection to non-standard port",
		pattern: /new\s+WebSocket\s*\(\s*["']wss?:\/\/[^"']*:(\d+)/,
	},
];

const STANDARD_PORTS = new Set([80, 443, 8080, 8443, 3000]);

const SOURCE_RULES: SourceRule[] = [
	{
		ruleId: "potential-exfiltration",
		severity: "warn",
		message:
			"File read combined with network send — possible data exfiltration",
		pattern: /readFileSync|readFile/,
		requiresContext: /\bfetch\b|\bpost\b|http\.request/i,
	},
	{
		ruleId: "obfuscated-code",
		severity: "warn",
		message: "Hex-encoded string sequence detected (possible obfuscation)",
		pattern: /(\\x[0-9a-fA-F]{2}){6,}/,
	},
	{
		ruleId: "obfuscated-code",
		severity: "warn",
		message:
			"Large base64 payload with decode call detected (possible obfuscation)",
		pattern: /(?:atob|Buffer\.from)\s*\(\s*["'][A-Za-z0-9+/=]{200,}["']/,
	},
	{
		ruleId: "env-harvesting",
		severity: "critical",
		message:
			"Environment variable access combined with network send — possible credential harvesting",
		pattern: /process\.env/,
		requiresContext: /\bfetch\b|\bpost\b|http\.request/i,
	},
];

export function scanCodeSource(
	source: string,
	filePath: string,
): SkillScanFinding[] {
	const findings: SkillScanFinding[] = [];
	const lines = source.split("\n");
	const matchedLineRules = new Set<string>();

	for (const rule of LINE_RULES) {
		if (matchedLineRules.has(rule.ruleId)) continue;
		if (rule.requiresContext && !rule.requiresContext.test(source)) continue;

		for (let i = 0; i < lines.length; i++) {
			const match = rule.pattern.exec(lines[i]);
			if (!match) continue;

			if (rule.ruleId === "suspicious-network") {
				const port = parseInt(match[1], 10);
				if (STANDARD_PORTS.has(port)) continue;
			}

			findings.push({
				ruleId: rule.ruleId,
				severity: rule.severity,
				file: filePath,
				line: i + 1,
				message: rule.message,
				evidence: truncateEvidence(lines[i].trim()),
			});
			matchedLineRules.add(rule.ruleId);
			break;
		}
	}

	const matchedSourceRules = new Set<string>();
	for (const rule of SOURCE_RULES) {
		const ruleKey = `${rule.ruleId}::${rule.message}`;
		if (matchedSourceRules.has(ruleKey)) continue;
		if (!rule.pattern.test(source)) continue;
		if (rule.requiresContext && !rule.requiresContext.test(source)) continue;

		let matchLine = 0;
		let matchEvidence = "";
		for (let i = 0; i < lines.length; i++) {
			if (rule.pattern.test(lines[i])) {
				matchLine = i + 1;
				matchEvidence = lines[i].trim();
				break;
			}
		}
		if (matchLine === 0) {
			matchLine = 1;
			matchEvidence = source.slice(0, 120);
		}

		findings.push({
			ruleId: rule.ruleId,
			severity: rule.severity,
			file: filePath,
			line: matchLine,
			message: rule.message,
			evidence: truncateEvidence(matchEvidence),
		});
		matchedSourceRules.add(ruleKey);
	}

	return findings;
}

export { LINE_RULES, SOURCE_RULES };
