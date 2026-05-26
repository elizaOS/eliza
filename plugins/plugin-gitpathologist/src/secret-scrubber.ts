/**
 * Local secret scrubber for raw text (commit messages, diff snippets).
 *
 * Kept independent of plugin-training's privacy-filter — that filter operates
 * on trajectory objects, not raw strings, and pulling it in would create a
 * cross-plugin dependency for one regex pass.
 *
 * Patterns aligned with plugin-training/privacy-filter:
 *   - Anthropic / OpenAI style keys (sk-ant-..., sk-...)
 *   - GitHub PATs (ghp_, gho_, ghu_, ghs_, ghr_)
 *   - AWS access keys (AKIA...)
 *   - Bearer tokens in headers
 *   - Long opaque hex/base64 chunks that follow known secret-y env names
 */

const SECRET_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "ANTHROPIC", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { label: "OPENAI", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { label: "GITHUB", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { label: "AWS", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: "SLACK", pattern: /\bxox[bpoa]-[A-Za-z0-9-]{10,}\b/g },
  { label: "BEARER", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g },
];

const SECRET_ENV_NAME = /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|API|AUTH|CREDENTIAL)[A-Z0-9_]*)\s*[:=]\s*['"]?([A-Za-z0-9_\-.+/=]{12,})['"]?/g;

export function scrubSecrets(input: string): string {
  if (!input) return input;
  let out = input;
  for (const { label, pattern } of SECRET_PATTERNS) {
    out = out.replace(pattern, `<REDACTED:${label}>`);
  }
  out = out.replace(SECRET_ENV_NAME, (_match, name: string) => `${name}=<REDACTED:ENV>`);
  return out;
}

export function scrubSecretsDeep<T>(value: T): T {
  if (typeof value === "string") return scrubSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map(scrubSecretsDeep) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubSecretsDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}
