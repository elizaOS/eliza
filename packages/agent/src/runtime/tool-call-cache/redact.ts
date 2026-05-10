/**
 * Default privacy redactor for the tool-call cache.
 *
 * The full trajectory privacy filter operates on a richer trajectory shape
 * (steps, llmCalls, metadata) and exists in `plugins/app-training`. Pulling
 * that dependency into app-core would invert the layer order, so we keep a
 * focused redactor here that mirrors the credential + geo passes from that
 * filter and is applied to every disk write.
 *
 * The redactor walks the value tree and replaces:
 *   - common API key shapes (`sk-…`, `Bearer …`, `ghp_…`, `AKIA…`)
 *   - environment-variable values whose key name looks like a secret
 *   - geographic coordinates (matching the Location-plugin patterns)
 */

import type { PrivacyRedactor } from "./types.ts";

const CREDENTIAL_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { label: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { label: "bearer", pattern: /\bBearer\s+[A-Za-z0-9._-]{16,}\b/g },
  { label: "github-token", pattern: /\bghp_[A-Za-z0-9]{20,}\b/g },
  { label: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
];

const GEO_PATTERNS: RegExp[] = [
  /"coords"\s*:\s*\{\s*"latitude"\s*:\s*-?\d+(?:\.\d+)?\s*,\s*"longitude"\s*:\s*-?\d+(?:\.\d+)?(?:\s*,\s*"[A-Za-z_][A-Za-z0-9_]*"\s*:\s*[^,}]+)*\s*\}/g,
  /"latitude"\s*:\s*-?\d+(?:\.\d+)?\s*,\s*"longitude"\s*:\s*-?\d+(?:\.\d+)?/g,
  /\b(?:current\s+location|location|coords|coordinates)\s*[:=]\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?/gi,
  /\b(?:lat|latitude)\s*[:=]\s*-?\d+(?:\.\d+)?\s*[,;]\s*(?:lng|lon|long|longitude)\s*[:=]\s*-?\d+(?:\.\d+)?/gi,
  /\b-?\d{1,3}\.\d{2,}\s*,\s*-?\d{1,3}\.\d{2,}\b/g,
];

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|API|CREDENTIAL/i;

function snapshotEnvCredentials(): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (!SECRET_NAME.test(key)) continue;
    if (typeof value !== "string" || value.length < 8) continue;
    out.push(value);
  }
  return out;
}

function redactString(input: string, envValues: string[]): string {
  let out = input;
  for (const pattern of GEO_PATTERNS) {
    out = out.replace(pattern, "[REDACTED_GEO]");
  }
  for (const { label, pattern } of CREDENTIAL_PATTERNS) {
    out = out.replace(pattern, `<REDACTED:${label}>`);
  }
  for (const credValue of envValues) {
    if (!credValue) continue;
    const escaped = credValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "g"), "<REDACTED:env-secret>");
  }
  return out;
}

function walk(value: unknown, envValues: string[]): unknown {
  if (typeof value === "string") {
    return redactString(value, envValues);
  }
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, envValues));
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      out[key] = walk(obj[key], envValues);
    }
    return out;
  }
  return value;
}

export const defaultPrivacyRedactor: PrivacyRedactor = (value) => {
  const envValues = snapshotEnvCredentials();
  return walk(value, envValues);
};
