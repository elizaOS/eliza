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

/** URL tokens in prose: scheme through the first stopping delimiter. */
const URL_TOKEN_PATTERN = /https?:\/\/[^\s)\]"'<>]+/gi;

/**
 * A host is safe iff it equals a listed domain or is a subdomain of one
 * (`host === safe` or `host.endsWith("." + safe)`). This deliberately rejects
 * suffix spoofs like `github.com.evil.com`, which is a distinct registrable
 * host, not a subdomain of `github.com`.
 */
function isSafeHost(host: string, safeDomains: ReadonlyArray<string>): boolean {
	const normalized = host.toLowerCase().replace(/\.$/, "");
	if (normalized.length === 0) return false;
	return safeDomains.some(
		(safe) => normalized === safe || normalized.endsWith(`.${safe}`),
	);
}

/**
 * Parse the effective host and userinfo presence from a URL token. Uses the
 * WHATWG URL parser so that userinfo phishing forms
 * (`raw.githubusercontent.com@evil.com`) resolve to their real host (`evil.com`)
 * instead of the spoofed prefix. A token the parser rejects falls back to a
 * conservative manual split so an evasive string is never silently allowed.
 */
function parseUrlToken(
	token: string,
): { host: string; hasUserinfo: boolean } {
	const authority = token.replace(/^https?:\/\//i, "").split(/[/?#]/, 1)[0];
	const hasUserinfoDelimiter = authority.lastIndexOf("@") >= 0;
	try {
		const url = new URL(token);
		return {
			host: url.hostname,
			hasUserinfo:
				url.username.length > 0 || url.password.length > 0 || hasUserinfoDelimiter,
		};
	} catch {
		// error-policy:J3 malformed URL token: derive a best-effort host from the
		// authority component so a parser-evading spoof is treated as external.
		const atIndex = authority.lastIndexOf("@");
		const hasUserinfo = atIndex >= 0;
		const hostPort = hasUserinfo ? authority.slice(atIndex + 1) : authority;
		const host = hostPort.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
		return { host, hasUserinfo };
	}
}

/**
 * True when a line carries an external URL that is not on the safe-domain
 * allowlist. Flags suffix spoofs (`github.com.evil.com`), userinfo spoofs
 * whose real host is external (`raw.githubusercontent.com@evil.com`), and any
 * URL that embeds userinfo at all: a documented safe-domain link never carries
 * credentials, and userinfo is the canonical phishing form the scanner exists
 * to surface.
 */
function buildExternalUrlMatcher(
	extra: ReadonlyArray<string> = [],
): (line: string) => boolean {
	const safeDomains = [...DEFAULT_SAFE_DOMAINS, ...extra];
	return (line: string): boolean => {
		const tokens = line.match(URL_TOKEN_PATTERN);
		if (!tokens) return false;
		for (const token of tokens) {
			const { host, hasUserinfo } = parseUrlToken(token);
			if (hasUserinfo) return true;
			if (!isSafeHost(host, safeDomains)) return true;
		}
		return false;
	};
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
			pattern: /https?:\/\//i,
			match: buildExternalUrlMatcher(additionalSafeDomains),
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
			const matched = rule.match
				? rule.match(lines[i])
				: rule.pattern.test(lines[i]);
			if (!matched) continue;

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
