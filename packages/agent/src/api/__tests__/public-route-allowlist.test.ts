/**
 * Regression guard for issue #9948.
 *
 * The central HTTP authorization gate is `route.public !== true && !isAuthorized()`,
 * so a route declared with `public: true` bypasses auth entirely. Nothing else
 * prevents a new public route from being added silently. This test scans the repo
 * source for every route/page declared `public: true` and fails if one appears that
 * is not enumerated — with a one-line rationale — in {@link ALLOWLIST} below.
 *
 * To add a legitimately-public route: add its identity to ALLOWLIST with a short
 * justification. To remove one: delete the matching ALLOWLIST entry. Anything else
 * (an unreviewed, unjustified public route) turns this test red.
 *
 * Deterministic: pure filesystem/text scan of the repo source, no runtime or model.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// packages/agent/src/api/__tests__ -> repo root
const REPO_ROOT = path.resolve(HERE, "../../../../..");
const SCAN_DIRS = ["packages", "plugins"] as const;

const HTTP_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "OPTIONS",
  "HEAD",
]);
// Direct keys that mark an object literal as an HTTP route / page declaration
// (as opposed to, say, a secrets-config entry that also carries `public: true`).
const ROUTE_MARKER_KEYS = [
  "handler",
  "routeHandler",
  "rawPath",
  "element",
  "component",
] as const;

interface PublicRoute {
  pathLit: string | null;
  name: string | null;
  file: string;
  identity: string;
}

/** Stable, human-readable identity for an allowlist key. */
function identityOf(pathLit: string | null, name: string | null): string {
  if (pathLit) return name ? `${pathLit} (${name})` : pathLit;
  // Routes whose `path` is a runtime expression (e.g. `path: WEBHOOK_PATH`) are
  // keyed by their literal `name`. The caller guarantees one of the two exists.
  return name ?? "";
}

function listSourceFiles(dir: string, acc: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      listSourceFiles(full, acc);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    if (entry.name.endsWith(".d.ts")) continue;
    acc.push(full);
  }
}

/** Find the `{ … }` object literal that immediately encloses position `idx`. */
function enclosingObjectLiteral(text: string, idx: number): string | null {
  let depth = 0;
  let start = -1;
  for (let i = idx; i >= 0; i--) {
    const c = text[i];
    if (c === "}") depth++;
    else if (c === "{") {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  if (start === -1) return null;
  depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  return text.slice(start, end + 1);
}

interface DirectProp {
  /** First string-literal value, or null when the value is an expression. */
  lit: string | null;
}

/** Direct (depth-1) properties of an object-literal body that starts with `{`. */
function directProps(objBody: string): Map<string, DirectProp> {
  const props = new Map<string, DirectProp>();
  let depth = 0;
  for (let i = 0; i < objBody.length; i++) {
    const c = objBody[i];
    if (c === "{") {
      depth++;
      continue;
    }
    if (c === "}") {
      depth--;
      continue;
    }
    if (depth !== 1) continue;
    const slice = objBody.slice(i);
    const keyMatch = slice.match(/^\s*([A-Za-z_$][\w$]*)\s*:/);
    if (!keyMatch) continue;
    const key = keyMatch[1];
    const after = slice.slice(keyMatch[0].length);
    const litMatch = after.match(/^\s*(["'`])([^"'`]*)\1/);
    if (!props.has(key)) {
      props.set(key, { lit: litMatch ? litMatch[2] : null });
    }
    i += keyMatch[0].length - 1;
  }
  return props;
}

function isCommentedLineAt(text: string, idx: number): boolean {
  const lineStart = text.lastIndexOf("\n", idx) + 1;
  const lineEndRaw = text.indexOf("\n", idx);
  const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
  const trimmed = text.slice(lineStart, lineEnd).trim();
  return (
    trimmed.startsWith("*") ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*")
  );
}

interface PublicTrueCandidate {
  idx: number;
  direct: boolean;
}

function publicTrueSpreadNames(text: string): Set<string> {
  const names = new Set<string>();
  const re =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{[^{}]*\bpublic:\s*true\b[^{}]*\}/gs;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const idx = m.index;
    if (isCommentedLineAt(text, idx)) continue;
    const name = m[1];
    if (name) names.add(name);
  }
  return names;
}

function publicRouteCandidatePositions(text: string): PublicTrueCandidate[] {
  const candidates: PublicTrueCandidate[] = [];
  const seen = new Set<number>();
  const directRe = /public:\s*true\b/g;
  for (let m = directRe.exec(text); m !== null; m = directRe.exec(text)) {
    if (seen.has(m.index)) continue;
    seen.add(m.index);
    candidates.push({ idx: m.index, direct: true });
  }

  const spreadNames = publicTrueSpreadNames(text);
  if (spreadNames.size === 0) return candidates;
  const spreadRe = /\.\.\.\s*([A-Za-z_$][\w$]*)/g;
  for (let m = spreadRe.exec(text); m !== null; m = spreadRe.exec(text)) {
    const name = m[1];
    if (!name || !spreadNames.has(name)) continue;
    if (seen.has(m.index)) continue;
    seen.add(m.index);
    candidates.push({ idx: m.index, direct: false });
  }
  return candidates;
}

/**
 * Extract every `public: true` route/page declaration from a single TypeScript
 * source string. A declaration counts when its enclosing object literal both
 * looks like a route (HTTP-method `type`, or a route-marker key, or a literal
 * `path`) and carries a literal identity (`path` or `name`). This deliberately
 * excludes: `is_public` DB fields, `public: true;` type members, commented-out
 * lines, secrets-config entries (`type: "credential"`), and generic route
 * factories whose `path`/`name` are runtime expressions.
 */
function extractPublicRoutes(text: string, file: string): PublicRoute[] {
  if (!text.includes("public")) return [];
  const out: PublicRoute[] = [];
  for (const candidate of publicRouteCandidatePositions(text)) {
    const idx = candidate.idx;
    // `is_public: true` — not the route flag.
    if (
      candidate.direct &&
      text.slice(Math.max(0, idx - 3), idx).endsWith("is_")
    ) {
      continue;
    }
    // `public: true;` — a literal-type member in an interface, not a value.
    if (candidate.direct) {
      const directMatch = text.slice(idx).match(/^public:\s*true\b/);
      const tail = text
        .slice(idx + (directMatch?.[0].length ?? "public: true".length))
        .match(/^\s*(\S)/);
      if (tail && tail[1] === ";") continue;
    }
    // Commented-out line.
    if (isCommentedLineAt(text, idx)) continue;
    const objBody = enclosingObjectLiteral(text, idx);
    if (!objBody) continue;
    const props = directProps(objBody);
    const pathProp = props.get("path");
    const typeProp = props.get("type");
    const nameProp = props.get("name");
    const hasLiteralPath = pathProp?.lit != null;
    const hasHttpType = typeProp?.lit != null && HTTP_METHODS.has(typeProp.lit);
    const hasMarker = ROUTE_MARKER_KEYS.some((k) => props.has(k));
    if (!hasLiteralPath && !hasHttpType && !hasMarker) continue;
    const pathLit = hasLiteralPath ? (pathProp?.lit ?? null) : null;
    const name = nameProp?.lit ?? null;
    // Generic route factories propagate `path`/`name` from runtime specs; the
    // concrete routes they emit are declared (and allowlisted) elsewhere.
    if (!pathLit && !name) continue;
    out.push({
      pathLit,
      name,
      file,
      identity: identityOf(pathLit, name),
    });
  }
  return out;
}

function scanRepo(): PublicRoute[] {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) {
    const abs = path.join(REPO_ROOT, dir);
    if (fs.existsSync(abs)) listSourceFiles(abs, files);
  }
  const routes: PublicRoute[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const route of extractPublicRoutes(
      text,
      path.relative(REPO_ROOT, file),
    )) {
      const dedupe = `${route.identity} ${route.file}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      routes.push(route);
    }
  }
  return routes;
}

/**
 * Every route/page allowed to set `public: true`, keyed by {@link identityOf}
 * with a one-line rationale. Adding an unlisted public route fails this test.
 */
const ALLOWLIST: Record<string, string> = {
  // plugin-browser — companion browser-extension callbacks, authenticated by the
  // companion session token rather than the dashboard JWT.
  "/api/browser-bridge/companions/revoke":
    "browser-extension companion revoke; companion-token auth, not dashboard JWT",
  "/api/browser-bridge/companions/sessions/:id/complete":
    "browser-extension companion session complete; companion-token auth",
  "/api/browser-bridge/companions/sessions/:id/actions/begin":
    "browser-extension companion session action begin; companion-token auth (getBrowserCompanionAuth + pairing token), rate limited",
  "/api/browser-bridge/companions/sessions/:id/progress":
    "browser-extension companion session progress; companion-token auth",
  "/api/browser-bridge/companions/preflight":
    "browser-extension companion preflight; companion-token auth, same gate as /companions/sync",
  "/api/browser-bridge/companions/sync":
    "browser-extension companion sync; companion-token auth",

  // plugin-computeruse
  "/api/computer-use/approvals/stream (computeruse-approvals-stream)":
    "SSE approvals stream; EventSource cannot send the JWT header",

  // plugin-personal-assistant — external OAuth provider redirects arrive without a JWT.
  "/api/connectors/google/oauth/callback (connectors.google.oauth.callback)":
    "Google OAuth provider redirect (GET); arrives without dashboard JWT",
  "/api/connectors/google/oauth/callback (connectors.google.oauth.callback.post)":
    "Google OAuth provider redirect (POST); arrives without dashboard JWT",
  "/api/lifeops/connectors/health/:provider/callback (lifeops.health.callback)":
    "health-connector OAuth provider redirect; arrives without dashboard JWT",
  "/api/lifeops/connectors/health/:provider/success (lifeops.health.success)":
    "health-connector OAuth provider return; arrives without dashboard JWT",
  "/api/lifeops/money/plaid/webhook (lifeops.money.plaid.webhook)":
    "Plaid webhook delivery; ES256 signature, exact-body hash, freshness, ingress deadline, body bound, and per-address rate limit apply before state work",

  // plugin-calendar — Google pushes arrive without a dashboard session and
  // are authenticated against the persisted channel/resource/token binding.
  "/api/lifeops/calendar/google/webhook (google-calendar-push-notification)":
    "Google calendar push delivery; provider binding, body bounds, and admission limits apply before scheduling",

  // @elizaos/agent
  "/api/media/:filename (media-file)":
    "iOS in-process media GET; the sha256 hash in the path is the capability",

  // @elizaos/core
  "/api/oauth/callback (oauth-local-callback)":
    "OAuth provider redirect; arrives without dashboard JWT",
  "/fixture/route (fixture-route)":
    "in-repo capability test fixture route; not shipped to production",

  // plugin-wallet — read-only market data. The local EVM/Solana signing routes
  // are no longer public (they run behind the central session gate plus their
  // own WALLET_BROWSER_SIGN_TOKEN check), so only market-overview stays here.
  "/api/wallet/market-overview (wallet-market-overview)":
    "public read-only market data; no per-user data exposed",

  // plugin-whatsapp — Meta requires the webhook endpoints to bypass auth.
  "/api/whatsapp/webhook (whatsapp-webhook-verify)":
    "Meta webhook verification must bypass auth",
  "/api/whatsapp/webhook (whatsapp-webhook-event)":
    "Meta webhook delivery must bypass auth",

  // @elizaos/ui cloud public pages — reachable by external/unauthenticated users.
  "payment/:paymentRequestId":
    "cloud public page: external payer; the request id is the capability link",
  "payment/success": "cloud public page: payment success landing",
  "payment/app-charge/:appId/:chargeId":
    "cloud public page: external payer; the charge id is the capability link",
  "approve/:approvalId":
    "cloud public page: by-id approval capability link, reachable pre-auth",
  "ballot/:ballotId":
    "cloud public page: by-id ballot capability link, reachable pre-auth",
  "sensitive-requests/:requestId":
    "cloud public page: by-id sensitive-request link, reachable pre-auth",
  "chat/:characterRef": "cloud public page: shareable public chat link",
  "invite/accept":
    "cloud public page: invitation acceptance, reachable pre-auth",
  "accept-invitation":
    "cloud public page: invitation acceptance, reachable pre-auth",
  login: "cloud public page: login flow, by definition pre-authentication",
  "auth/success": "cloud public page: auth flow, pre-authentication",
  "auth/error": "cloud public page: auth flow, pre-authentication",
  "auth/cli-login": "cloud public page: CLI auth flow, pre-authentication",
  "auth/callback/email":
    "cloud public page: email auth callback, pre-authentication",
  "auth/bridge":
    "cloud public page: sso bridge leg between the dashboard and app origins; must render pre-auth to carry the one-time code, and every privileged step happens server-side behind Origin, referrer, and PKCE checks",
  "app-auth/authorize": "cloud public page: app-auth flow, pre-authentication",
  "oidc/continue":
    "cloud public page: resumes the OpenID Provider authorization request after login; must render before authentication so the API origin can validate the parked request",
  "terms-of-service": "cloud public page: legal page, no auth",
  "privacy-policy": "cloud public page: legal page, no auth",
  "account-deletion":
    "cloud public page: legal page (store-mandated deletion instructions), no auth",
  bsc: "cloud public page: BSC landing page, no auth",
};

describe("public:true route allowlist (#9948)", () => {
  const discovered = scanRepo();

  it("finds the public-route declarations it is meant to guard", () => {
    expect(fs.existsSync(path.join(REPO_ROOT, "packages"))).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, "plugins"))).toBe(true);
    // Guard against a silently-broken scanner reporting nothing.
    expect(discovered.length).toBeGreaterThan(30);
  });

  it("every public:true route is enumerated in the allowlist", () => {
    const unlisted = discovered
      .filter((r) => !(r.identity in ALLOWLIST))
      .map((r) => `${r.identity}  [${r.file}]`)
      .sort();
    expect(
      unlisted,
      `Unlisted public:true route(s) found. Each route that sets ` +
        `\`public: true\` bypasses the central isAuthorized gate. Add it to ` +
        `ALLOWLIST with a one-line rationale, or remove \`public: true\`:\n` +
        unlisted.join("\n"),
    ).toEqual([]);
  });

  it("has no stale allowlist entries", () => {
    const present = new Set(discovered.map((r) => r.identity));
    const stale = Object.keys(ALLOWLIST)
      .filter((id) => !present.has(id))
      .sort();
    expect(
      stale,
      `Allowlist entries no longer match any public:true route; remove them:\n` +
        stale.join("\n"),
    ).toEqual([]);
  });

  it("fails when a new, unlisted public route is added", () => {
    const fabricated = [
      "export const backdoorRoute = {",
      '  type: "POST",',
      '  path: "/api/secret-backdoor",',
      "  public: true,",
      '  name: "secret-backdoor",',
      "  handler: async () => ({ status: 200 }),",
      "};",
    ].join("\n");
    const routes = extractPublicRoutes(fabricated, "fabricated.ts");
    const identity = "/api/secret-backdoor (secret-backdoor)";
    expect(routes.map((r) => r.identity)).toContain(identity);
    // The whole point: a fabricated public route is NOT in the allowlist, so the
    // "every public:true route is enumerated" assertion above would fail for it.
    expect(identity in ALLOWLIST).toBe(false);
  });

  it("detects public routes that inherit the flag from a reviewed spread object", () => {
    const fabricated = [
      "const PUBLIC_ROUTE_ACCESS = { public: true };",
      "export const spreadRoute = {",
      "  ...PUBLIC_ROUTE_ACCESS,",
      '  type: "GET",',
      '  path: "/api/spread-public",',
      '  name: "spread-public",',
      "  handler: async () => ({ status: 200 }),",
      "};",
    ].join("\n");
    const routes = extractPublicRoutes(fabricated, "fabricated-spread.ts");
    expect(routes.map((r) => r.identity)).toContain(
      "/api/spread-public (spread-public)",
    );
  });

  it("ignores type members, comments, is_public fields, and non-route configs", () => {
    const noise = [
      "interface PublicRouteSpec { type: HttpRouteType; path: string; public: true; name: string; }",
      "const dbRow = { is_public: true, owner: 1 };",
      "// a route with public: true in a comment should be ignored",
      'const secret = { name: "Twitter Username", type: "credential", public: true, required: false };',
      "const factory = (spec) => ({ type: spec.type, path: spec.path, public: true, handler });",
    ].join("\n");
    expect(extractPublicRoutes(noise, "noise.ts")).toEqual([]);
  });
});
