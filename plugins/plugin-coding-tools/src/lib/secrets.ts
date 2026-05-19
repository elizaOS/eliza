// Conservative secret detection. Catches the obvious: AWS keys, GitHub tokens,
// generic high-entropy assignments to *_SECRET / *_TOKEN / *_KEY. Designed to
// gate WRITE/EDIT, not to be a full DLP solution.

const PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "aws_access_key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "github_token", regex: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: "github_oauth", regex: /\bgho_[A-Za-z0-9]{36}\b/ },
  { name: "github_app", regex: /\b(ghu|ghs)_[A-Za-z0-9]{36}\b/ },
  { name: "openai_key", regex: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: "anthropic_key", regex: /\bsk-ant-[A-Za-z0-9_-]{90,}\b/ },
  { name: "google_api_key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "slack_token", regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "stripe_secret", regex: /\bsk_live_[A-Za-z0-9]{24,}\b/ },
  {
    name: "private_key_pem",
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  },
  {
    name: "jwt_like",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
];

export interface SecretMatch {
  name: string;
  preview: string;
}

export function detectSecrets(content: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  for (const { name, regex } of PATTERNS) {
    const m = regex.exec(content);
    if (m) {
      const found = m[0];
      const preview =
        found.length > 16 ? `${found.slice(0, 6)}…${found.slice(-4)}` : found;
      matches.push({ name, preview });
    }
  }
  return matches;
}
