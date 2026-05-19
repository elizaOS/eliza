/**
 * Markdown scanner — checks SKILL.md for instruction-based attacks.
 * Targets the Feb 2026 ClawHub attack patterns: malicious URLs in markdown,
 * pipe-to-shell, prompt injection, credential exfiltration instructions.
 */

import type { LineRule, SkillScanFinding } from "./types";
import { truncateEvidence } from "./types";

const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx", ".markdown"]);

export function isMarkdown(filePath: string): boolean {
	const dotIndex = filePath.lastIndexOf(".");
	if (dotIndex < 0) return false;
	return MARKDOWN_EXTENSIONS.has(filePath.slice(dotIndex).toLowerCase());
}

const DEFAULT_SAFE_DOMAINS: ReadonlyArray<string> = [
	"github.com",
	"raw.githubusercontent.com",
	"gist.githubusercontent.com",
	"clawhub.ai",
	"clawhub.com",
	"skillsmp.com",
	"agentskills.io",
	"npmjs.com",
	"npmjs.org",
	"pypi.org",
	"docs.rs",
	"crates.io",
	"pkg.go.dev",
	"brew.sh",
	"wttr.in",
	"docs.anthropic.com",
	"docs.openai.com",
	"developer.mozilla.org",
	"wikipedia.org",
	"en.wikipedia.org",
	"stackoverflow.com",
];

function buildExternalUrlPattern(extra: ReadonlyArray<string> = []): RegExp {
	const all = [...DEFAULT_SAFE_DOMAINS, ...extra];
	const lookahead = all.map((d) => d.replace(/\./g, "\\.")).join("|");
	return new RegExp(
		`https?:\\/\\/(?!(${lookahead})\\b)[a-zA-Z0-9][^\\s)\\]"'<>]*`,
	);
}

export function buildMarkdownRules(
	additionalSafeDomains: ReadonlyArray<string> = [],
): LineRule[] {
	return [
		// Critical: active exploitation patterns
		{
			ruleId: "md-pipe-to-shell",
			severity: "critical",
			message: "Pipe-to-shell pattern detected",
			pattern: /\|\s*(ba)?sh\b|\|\s*sudo\b|\|\s*python[23]?\b/,
		},
		{
			ruleId: "md-curl-exec",
			severity: "critical",
			message: "Download-and-execute pattern detected",
			pattern: /curl\s+[^\n]*\|\s*(ba)?sh|wget\s+[^\n]*\|\s*(ba)?sh/i,
		},
		{
			ruleId: "md-prompt-injection",
			severity: "critical",
			message: "Prompt injection — instruction override attempt",
			pattern:
				/ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|rules|guidelines|context)/i,
		},
		{
			ruleId: "md-credential-send",
			severity: "critical",
			message: "Instruction to send credentials to external service",
			pattern:
				/send\s+(the\s+)?(api[_\s-]?key|token|secret|password|credential|private[_\s-]?key)\s+(to|via|using|over)\b/i,
		},
		{
			ruleId: "md-base64-decode-exec",
			severity: "critical",
			message: "Base64 decode and execute pattern",
			pattern:
				/base64\s+(--)?decode?\b.*\|\s*(ba)?sh|echo\s+[A-Za-z0-9+/=]{50,}\s*\|\s*base64/i,
		},
		{
			ruleId: "md-hidden-content",
			severity: "critical",
			message: "Zero-width or invisible Unicode characters detected",
			pattern: /(?:\u200B|\u200C|\u200D|\uFEFF|\u2060)/,
		},
		{
			ruleId: "md-role-impersonation",
			severity: "critical",
			message: "System/assistant role impersonation detected",
			pattern: /^(system|assistant)\s*:/im,
		},
		{
			ruleId: "md-instruction-reset",
			severity: "critical",
			message: "Instruction boundary reset attempt",
			pattern:
				/\b(new\s+instructions|override\s+instructions|disregard\s+(all|previous|prior)|forget\s+(everything|all|previous))\b/i,
		},

		// Warn: suspicious but potentially legitimate
		{
			ruleId: "md-external-url",
			severity: "warn",
			message: "External URL detected (not on safe domain list)",
			pattern: buildExternalUrlPattern(additionalSafeDomains),
		},
		{
			ruleId: "md-env-credential",
			severity: "warn",
			message: "References sensitive environment variable",
			pattern:
				/\$\{?\w*(API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE[_-]?KEY|AUTH)\w*\}?/i,
		},
		{
			ruleId: "md-system-path-write",
			severity: "warn",
			message: "References writing to system paths",
			pattern: />\s*\/etc\/|>\s*\/usr\/|>\s*~\/\.|>\s*\/tmp\//,
		},
		{
			ruleId: "md-npm-global-install",
			severity: "warn",
			message: "Global package install instruction",
			pattern: /npm\s+i(nstall)?\s+(-g|--global)\b/,
		},
		{
			ruleId: "md-chmod-exec",
			severity: "warn",
			message: "Makes file executable",
			pattern: /chmod\s+\+x\b|chmod\s+[0-7]*[1357][0-7]*\b/,
		},
		{
			ruleId: "md-sudo-usage",
			severity: "warn",
			message: "Uses sudo (elevated privileges)",
			pattern: /\bsudo\s+/,
		},
		{
			ruleId: "md-data-uri",
			severity: "warn",
			message: "Data URI with large base64 payload",
			pattern: /data:[a-zA-Z]+\/[a-zA-Z+.-]+;base64,[A-Za-z0-9+/=]{100,}/,
		},
	];
}

export function scanMarkdownSource(
	source: string,
	filePath: string,
	additionalSafeDomains: ReadonlyArray<string> = [],
): SkillScanFinding[] {
	const rules = buildMarkdownRules(additionalSafeDomains);
	const findings: SkillScanFinding[] = [];
	const lines = source.split("\n");
	const matchedRules = new Set<string>();

	for (const rule of rules) {
		if (matchedRules.has(rule.ruleId)) continue;
		if (rule.requiresContext && !rule.requiresContext.test(source)) continue;

		for (let i = 0; i < lines.length; i++) {
			if (!rule.pattern.test(lines[i])) continue;

			findings.push({
				ruleId: rule.ruleId,
				severity: rule.severity,
				file: filePath,
				line: i + 1,
				message: rule.message,
				evidence: truncateEvidence(lines[i].trim()),
			});
			matchedRules.add(rule.ruleId);
			break;
		}
	}

	return findings;
}

export { DEFAULT_SAFE_DOMAINS };
