/**
 * Generate the OIDC signing key ring (`OIDC_SIGNING_JWKS`) and, optionally, a
 * relying-party registry entry (`OIDC_CLIENTS`) with a fresh client secret.
 *
 * RS256 by default: OpenID Connect Core effectively requires an OP to support
 * it, and the first relying party here is a Go/goth client whose accepted
 * algorithms are not something this repository can verify. Pass `--alg ES256`
 * for a smaller key once that is confirmed.
 *
 * Rotation is an overlap, not a cutover. `--rotate <existing-ring>` PREPENDS a
 * new key to a ring you already have: deploy the two-key ring, wait out the
 * access-token TTL plus the JWKS `max-age` plus the relying party's own cache,
 * then re-run with only the new key.
 *
 * Every knob a relying party's own configuration can force is a flag here,
 * because the alternative is hand-editing the registry JSON and discovering at
 * login time that a claim is missing:
 *   --audience         resource servers that must accept the ACCESS token
 *   --constant-claim   a fixed name=value pair for an RP that gates login on one
 *   --map-role/-group  translation into the RP's own roles/groups vocabulary
 *   --wallet-email-fallback  admit wallet-only accounts and mint a no-reply address
 * The generated entry is run through the Worker's own registry parser before it
 * is printed, so an incoherent combination fails here rather than as a 503.
 *
 * Uses console.log intentionally — this is an operator CLI. The client secret
 * is printed exactly once and is never stored anywhere; only its sha256 goes
 * into the registry.
 */

import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { parseOidcClientEntry } from "@elizaos/cloud-shared/lib/oidc/clients";

type SupportedAlg = "RS256" | "ES256";

interface PrivateJwk extends Record<string, unknown> {
  kid: string;
  alg: string;
  kty: string;
}

function arg(name: string): string | undefined {
  return args(name)[0];
}

/** Every value of a repeatable flag, in command-line order. */
function args(name: string): string[] {
  const values: string[] = [];
  for (const [index, token] of process.argv.entries()) {
    if (token !== `--${name}`) continue;
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`--${name} requires a value`);
    }
    values.push(value);
  }
  return values;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** `--map-role org_owner=steward,maintainer` → `{ org_owner: ["steward","maintainer"] }`. */
function pairs(name: string): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const raw of args(name)) {
    const separator = raw.indexOf("=");
    if (separator <= 0) {
      throw new Error(
        `--${name} expects <source>=<target>[,<target>...], got "${raw}"`,
      );
    }
    const key = raw.slice(0, separator).trim();
    const targets = raw
      .slice(separator + 1)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (!key || targets.length === 0) {
      throw new Error(
        `--${name} expects <source>=<target>[,<target>...], got "${raw}"`,
      );
    }
    map[key] = [...(map[key] ?? []), ...targets];
  }
  return map;
}

function list(name: string): string[] {
  return args(name).flatMap((raw) =>
    raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function defaultKid(): string {
  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return `oidc-${month}-${randomBytes(2).toString("hex")}`;
}

function generatePrivateJwk(alg: SupportedAlg, kid: string): PrivateJwk {
  const { privateKey } =
    alg === "RS256"
      ? generateKeyPairSync("rsa", { modulusLength: 2048 })
      : generateKeyPairSync("ec", { namedCurve: "P-256" });

  const jwk = privateKey.export({ format: "jwk" }) as Record<string, unknown>;
  return { ...jwk, kid, alg, kty: String(jwk.kty) } as PrivateJwk;
}

function parseExistingRing(raw: string): PrivateJwk[] {
  const text = raw.trim().startsWith("[")
    ? raw.trim()
    : Buffer.from(raw.trim(), "base64").toString("utf8");
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("--rotate expects a JSON array of private JWKs");
  }
  return parsed as PrivateJwk[];
}

const alg = (arg("alg") ?? "RS256").toUpperCase() as SupportedAlg;
if (alg !== "RS256" && alg !== "ES256") {
  throw new Error(`Unsupported --alg "${alg}"; use RS256 or ES256`);
}

const kid = arg("kid") ?? defaultKid();
const existing = arg("rotate");
const ring = [
  generatePrivateJwk(alg, kid),
  ...(existing ? parseExistingRing(existing) : []),
];

const kids = new Set<string>();
for (const key of ring) {
  if (kids.has(key.kid)) {
    throw new Error(`Duplicate kid "${key.kid}" in the resulting ring`);
  }
  kids.add(key.kid);
}

console.log("# Worker secret — wrangler secret put OIDC_SIGNING_JWKS\n");
console.log(`OIDC_SIGNING_JWKS=${JSON.stringify(ring)}\n`);
if (existing) {
  console.log(
    `# Ring order: "${ring[0]?.kid}" signs; ${ring.length - 1} retired key(s) stay published`,
  );
  console.log(
    "# Drop the retired key(s) only after (access-token TTL + JWKS max-age + RP cache) has elapsed.\n",
  );
}

const clientId = arg("client");
if (clientId) {
  const redirectUris = args("redirect-uri");
  if (redirectUris.length === 0) {
    throw new Error(
      "--client requires --redirect-uri (exact string, no wildcards)",
    );
  }

  const wantsAgents = hasFlag("eliza-agents");
  const scopes = list("scope");
  const allowedScopes =
    scopes.length > 0
      ? scopes
      : [
          "openid",
          "email",
          "profile",
          "groups",
          ...(wantsAgents ? ["eliza_agents"] : []),
        ];

  const secret = randomBytes(32).toString("base64url");
  const entry = {
    client_id: clientId,
    name: arg("client-name") ?? clientId,
    client_secret_sha256: createHash("sha256").update(secret).digest("hex"),
    redirect_uris: redirectUris,
    allowed_scopes: allowedScopes,
    // Resource servers that verify this client's ACCESS token with their own
    // configured `audience`. Merge Steward's OIDC_AUDIENCE belongs here; without
    // it jose rejects every token before any claim is read.
    resource_audiences: list("audience"),
    require_pkce: hasFlag("require-pkce"),
    require_verified_email: !hasFlag("allow-unverified-email"),
    // Off unless asked for: it is the only knob that changes what `email` can
    // hold, and a relying party that wants inbox proof must keep the default. It
    // WIDENS the verified-email gate, so pairing it with --allow-unverified-email
    // is refused by the parser below rather than printed.
    wallet_email_fallback: hasFlag("wallet-email-fallback"),
    roles_allowlist: list("roles-allowlist"),
    claims_policy: {
      groups: true,
      roles: true,
      tenant_id: true,
      eliza_agents: wantsAgents,
    },
    claims_mapping: {
      roles: pairs("map-role"),
      groups: pairs("map-group"),
      mode: hasFlag("replace-native-claims") ? "replace" : "extend",
    },
    constant_claims: Object.fromEntries(
      Object.entries(pairs("constant-claim")).map(([name, values]) => [
        name,
        values.join(","),
      ]),
    ),
    id_token_ttl_seconds: 300,
    access_token_ttl_seconds: 300,
  };

  // The Worker refuses to load a registry whose knobs cancel out. Running the
  // same parser here means this CLI cannot emit one.
  const parsed = parseOidcClientEntry(entry);

  console.log("# Worker secret — wrangler secret put OIDC_CLIENTS\n");
  console.log(`OIDC_CLIENTS=${JSON.stringify([entry])}\n`);
  console.log(`# Scopes:            ${parsed.allowed_scopes.join(" ")}`);
  console.log(
    `# Access token aud: ${[parsed.client_id, ...parsed.resource_audiences].join(", ")}`,
  );
  if (Object.keys(parsed.constant_claims).length > 0) {
    console.log(
      `# Constant claims:  ${Object.entries(parsed.constant_claims)
        .map(([name, value]) => `${name}=${value}`)
        .join(", ")}`,
    );
  }
  if (parsed.claims_mapping.mode === "replace") {
    console.log(
      "# Native roles/groups are DROPPED; only mapped values are emitted.",
    );
  }
  if (parsed.wallet_email_fallback) {
    console.log(
      "# Wallet fallback:  a user with a VERIFIED wallet and NO stored email is admitted",
    );
    console.log(
      "#                   and receives email=wallet-<32 hex>@users.noreply.<issuer hostname>",
    );
    console.log(
      '#                   with email_verified=false and eliza_email_source="wallet".',
    );
    console.log(
      "#                   That address has no mailbox by design; read eliza_email_source,",
    );
    console.log(
      "#                   not email_verified, for identity assurance.",
    );
  }
  console.log(
    "\n# Give this to the relying party. It is shown once and stored only as sha256.\n",
  );
  console.log(`CLIENT_SECRET=${secret}`);
}
