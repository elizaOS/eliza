import { getAddress, verifyMessage } from "viem";

export interface FarcasterLoginPayload {
  message?: unknown;
  signature?: unknown;
  custodyAddress?: unknown;
  address?: unknown;
  fid?: unknown;
  username?: unknown;
  displayName?: unknown;
  pfpUrl?: unknown;
  pfp?: unknown;
}

export interface ParsedSiwfMessage {
  domain: string;
  address: `0x${string}`;
  statement?: string;
  uri: string;
  version: string;
  chainId?: number;
  nonce: string;
  issuedAt: string;
  expirationTime?: string;
  notBefore?: string;
  requestId?: string;
  resources: string[];
  /** fid claimed by the message's farcaster:// resource — self-signed, NOT
   * verified against a hub/IdRegistry (SEC-058). Unverified metadata only. */
  fid?: string;
}

export interface VerifiedFarcasterUser {
  /**
   * The fid CLAIMED by the self-signed SIWF message's `farcaster://fid/N`
   * resource. NOT cryptographically bound to the signer (SEC-058): anyone can
   * place any fid in their own signed message, so this is unverified metadata.
   * Never key identity or authorization decisions on it — use
   * `custodyAddress`, which IS signature-verified. A verified fid would
   * require checking the fid→custody-address binding against a Farcaster
   * hub / the IdRegistry contract.
   */
  claimedFid: string;
  custodyAddress: `0x${string}`;
  username?: string;
  displayName?: string;
  pfpUrl?: string;
  message: ParsedSiwfMessage;
}

export interface VerifyFarcasterLoginOptions {
  expectedDomain?: string | string[];
  expectedNonce?: string;
  expectedUri?: string;
  nowMs?: number;
  clockSkewMs?: number;
  maxMessageAgeMs?: number;
  /** Require a fid CLAIM to be present in the signed message (default true).
   * Note the claim is unverified metadata — see VerifiedFarcasterUser.claimedFid. */
  requireFid?: boolean;
}

const HEX_SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;
const NONCE_RE = /^[A-Za-z0-9]{8,}$/;
const DEFAULT_CLOCK_SKEW_MS = 30_000;

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalizeFid(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
    return String(value);
  if (typeof value === "bigint" && value > 0n) return value.toString();
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) && BigInt(trimmed) > 0n ? trimmed : undefined;
}

function parseIsoDate(value: string, label: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${label} is invalid`);
  return ms;
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

function normalizeExpectedDomains(
  expected?: string | string[],
): Set<string> | null {
  if (!expected) return null;
  const domains = Array.isArray(expected) ? expected : [expected];
  const normalized = domains
    .map((domain) => normalizeDomain(domain))
    .filter((domain) => domain.length > 0);
  return normalized.length > 0 ? new Set(normalized) : null;
}

function parseField(line: string): [string, string] | null {
  const index = line.indexOf(":");
  if (index <= 0) return null;
  return [line.slice(0, index), line.slice(index + 1).trim()];
}

function extractFid(resources: string[]): string | undefined {
  for (const resource of resources) {
    const match = resource.match(/^farcaster:\/\/(?:fid|user)\/(\d+)$/i);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export function parseSiwfMessage(message: string): ParsedSiwfMessage {
  const normalizedMessage = message.replace(/\r\n/g, "\n");
  const lines = normalizedMessage.split("\n");
  if (lines.length < 6) throw new Error("SIWF message is too short");

  const domainLine = lines[0]?.trim() ?? "";
  const domainMatch = domainLine.match(
    /^(.+) wants you to sign in with your Ethereum account:$/,
  );
  const domain = domainMatch?.[1]?.trim();
  if (!domain || /\s/.test(domain) || domain.includes("/")) {
    throw new Error("SIWF domain is invalid");
  }

  const rawAddress = lines[1]?.trim();
  if (!rawAddress) throw new Error("SIWF address is required");
  let address: `0x${string}`;
  try {
    address = getAddress(rawAddress);
  } catch {
    throw new Error("SIWF address is invalid");
  }

  let index = 2;
  if (lines[index] !== "") throw new Error("SIWF message format is invalid");
  index += 1;

  const statementLines: string[] = [];
  while (index < lines.length && lines[index] !== "") {
    statementLines.push(lines[index] ?? "");
    index += 1;
  }
  if (statementLines.length > 0) index += 1;

  const fields = new Map<string, string>();
  const resources: string[] = [];
  let inResources = false;
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.length === 0) continue;
    if (inResources) {
      if (!line.startsWith("- "))
        throw new Error("SIWF resource line is invalid");
      resources.push(line.slice(2).trim());
      continue;
    }

    const parsed = parseField(line);
    if (!parsed) throw new Error("SIWF field is invalid");
    const [key, value] = parsed;
    if (key === "Resources") {
      if (value.length > 0) throw new Error("SIWF resources field is invalid");
      inResources = true;
      continue;
    }
    fields.set(key, value);
  }

  const uri = fields.get("URI");
  const version = fields.get("Version");
  const nonce = fields.get("Nonce");
  const issuedAt = fields.get("Issued At");
  if (!uri) throw new Error("SIWF URI is required");
  if (!version) throw new Error("SIWF version is required");
  if (!nonce) throw new Error("SIWF nonce is required");
  if (!issuedAt) throw new Error("SIWF issuedAt is required");
  if (version !== "1") throw new Error("SIWF version is unsupported");
  if (!NONCE_RE.test(nonce)) throw new Error("SIWF nonce is invalid");
  try {
    new URL(uri);
  } catch {
    throw new Error("SIWF URI is invalid");
  }

  const chainIdRaw = fields.get("Chain ID");
  const chainId = chainIdRaw ? Number(chainIdRaw) : undefined;
  if (chainIdRaw) {
    if (!Number.isSafeInteger(chainId) || (chainId ?? 0) <= 0) {
      throw new Error("SIWF chainId is invalid");
    }
  }

  const expirationTime = fields.get("Expiration Time");
  const notBefore = fields.get("Not Before");
  parseIsoDate(issuedAt, "SIWF issuedAt");
  if (expirationTime) parseIsoDate(expirationTime, "SIWF expirationTime");
  if (notBefore) parseIsoDate(notBefore, "SIWF notBefore");

  return {
    domain: domain.toLowerCase(),
    address,
    statement:
      statementLines.length > 0 ? statementLines.join("\n") : undefined,
    uri,
    version,
    chainId,
    nonce,
    issuedAt,
    expirationTime,
    notBefore,
    requestId: fields.get("Request ID"),
    resources,
    fid: extractFid(resources),
  };
}

export function validateSiwfMessage(
  parsed: ParsedSiwfMessage,
  options: VerifyFarcasterLoginOptions = {},
): void {
  const expectedDomains = normalizeExpectedDomains(options.expectedDomain);
  if (expectedDomains && !expectedDomains.has(normalizeDomain(parsed.domain))) {
    throw new Error("SIWF domain mismatch");
  }
  if (options.expectedNonce && parsed.nonce !== options.expectedNonce) {
    throw new Error("SIWF nonce mismatch");
  }
  if (options.expectedUri && parsed.uri !== options.expectedUri) {
    throw new Error("SIWF URI mismatch");
  }

  const nowMs = options.nowMs ?? Date.now();
  const clockSkewMs = options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
  const issuedAtMs = parseIsoDate(parsed.issuedAt, "SIWF issuedAt");
  if (issuedAtMs > nowMs + clockSkewMs) {
    throw new Error("SIWF message issuedAt is in the future");
  }
  if (
    options.maxMessageAgeMs &&
    nowMs - issuedAtMs > options.maxMessageAgeMs + clockSkewMs
  ) {
    throw new Error("SIWF message is too old");
  }
  if (parsed.expirationTime) {
    const expirationMs = parseIsoDate(
      parsed.expirationTime,
      "SIWF expirationTime",
    );
    if (nowMs - clockSkewMs >= expirationMs) {
      throw new Error("SIWF message is expired");
    }
  }
  if (parsed.notBefore) {
    const notBeforeMs = parseIsoDate(parsed.notBefore, "SIWF notBefore");
    if (nowMs + clockSkewMs < notBeforeMs) {
      throw new Error("SIWF message is not yet valid");
    }
  }
}

export async function verifyFarcasterLogin(
  payload: FarcasterLoginPayload,
  options: VerifyFarcasterLoginOptions = {},
): Promise<VerifiedFarcasterUser> {
  const message = requiredString(payload.message, "SIWF message");
  const signature = requiredString(payload.signature, "SIWF signature");
  if (!HEX_SIGNATURE_RE.test(signature))
    throw new Error("SIWF signature is invalid");

  const parsed = parseSiwfMessage(message);
  validateSiwfMessage(parsed, options);

  const claimedAddress =
    optionalString(payload.custodyAddress) ?? optionalString(payload.address);
  if (claimedAddress) {
    let normalizedClaim: `0x${string}`;
    try {
      normalizedClaim = getAddress(claimedAddress);
    } catch {
      throw new Error("Farcaster custodyAddress is invalid");
    }
    if (normalizedClaim !== parsed.address)
      throw new Error("Farcaster custodyAddress mismatch");
  }

  const verified = await verifyMessage({
    address: parsed.address,
    message,
    signature: signature as `0x${string}`,
  });
  if (!verified) throw new Error("SIWF signature mismatch");

  const payloadFid = normalizeFid(payload.fid);
  const fid = parsed.fid;
  if (payloadFid && parsed.fid !== payloadFid) {
    throw new Error("Farcaster fid mismatch");
  }
  if ((options.requireFid ?? true) && !fid)
    throw new Error("Farcaster fid is required");

  return {
    claimedFid: fid ?? "",
    custodyAddress: parsed.address,
    username: optionalString(payload.username),
    displayName: optionalString(payload.displayName),
    pfpUrl: optionalString(payload.pfpUrl) ?? optionalString(payload.pfp),
    message: parsed,
  };
}
