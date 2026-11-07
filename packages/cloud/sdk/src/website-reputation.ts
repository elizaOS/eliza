/**
 * Website reputation: host normalization, hash-prefix lookup and verdicts.
 *
 * The lookup is privacy preserving in the Safe Browsing sense: a client sends
 * only short SHA-256 prefixes of candidate host names, Cloud returns every
 * full hash on its threat lists that starts with one of those prefixes, and
 * the client compares full hashes locally. Cloud never receives the visited
 * address or a full host hash. A short prefix is not anonymity: Cloud could
 * test a prefix against a dictionary of known hosts. It only narrows what an
 * individual request discloses.
 *
 * Verdicts never claim that a site is safe. `not_listed` means only that the
 * loaded threat lists contain no entry for the host ("No known threat").
 * List age never changes a result: the last loaded copy of a list always
 * counts. `unavailable` means that no list has loaded or the index is
 * missing or corrupt.
 * Callers must never wait for this lookup before they open a page.
 *
 * Matching mirrors the on-device lookup in
 * `packages/os/browser/protection/reputation.mjs`: a list entry covers the
 * entry host and all of its subdomains, so the candidates are the host and
 * its parent domains down to two labels.
 */

export const WEBSITE_REPUTATION_LOOKUP_PATH =
  "/api/v1/website-reputation/lookup";
/** Default prefix length. Shorter prefixes disclose less and return more hashes. */
export const WEBSITE_REPUTATION_DEFAULT_PREFIX_BYTES = 4;
export const WEBSITE_REPUTATION_MIN_PREFIX_BYTES = 2;
export const WEBSITE_REPUTATION_MAX_PREFIX_BYTES = 4;
/** Upper bound on prefixes in one lookup request. */
export const WEBSITE_REPUTATION_MAX_PREFIXES = 64;
/** Exact host plus parent domains formed from the last six labels. */
const MAX_SUFFIX_LABELS = 6;

export type WebsiteReputationCategory =
  | "phishing"
  | "malware_or_scam"
  | "fake_shop_or_scam";

/** `loaded`: Cloud holds a validated copy of the list, of any age. */
export type WebsiteReputationListStatus = "loaded" | "unavailable";

/** Public, non-sensitive description of one threat list in the served snapshot. */
export interface WebsiteReputationListFreshness {
  id: string;
  source: string;
  category: WebsiteReputationCategory;
  status: WebsiteReputationListStatus;
  /** Publication time stated by the list publisher (ISO 8601), when known. Informational only. */
  publishedAt: string | null;
  /** Time Cloud downloaded and validated this list (ISO 8601). */
  fetchedAt: string | null;
  /** SHA-256 of the validated list body. */
  sha256: string | null;
}

/**
 * `complete`: every list has loaded. `partial`: at least one list has loaded.
 * `unavailable`: no list has loaded, or the index is missing or corrupt.
 */
export type WebsiteReputationIndexStatus =
  | "complete"
  | "partial"
  | "unavailable";

export interface WebsiteReputationLookupRequest {
  /** Lowercase hex SHA-256 prefixes, 2 to 4 bytes each. */
  prefixes: string[];
}

export interface WebsiteReputationMatch {
  /** Full lowercase hex SHA-256 of a listed host. */
  hash: string;
  /** IDs of loaded lists that contain this host. */
  lists: string[];
}

export interface WebsiteReputationLookupResponse {
  status: WebsiteReputationIndexStatus;
  generatedAt: string | null;
  lists: WebsiteReputationListFreshness[];
  matches: WebsiteReputationMatch[];
}

export type WebsiteReputationVerdict =
  | {
      status: "listed";
      host: string;
      /** The listed host or parent domain that matched. */
      matchedHost: string;
      sources: string[];
      categories: WebsiteReputationCategory[];
      warning: string;
    }
  | { status: "not_listed"; host: string; label: "No known threat" }
  | {
      status: "unavailable";
      host: string | null;
      reason: "invalid-address" | "local-address" | "unavailable";
    };

export interface WebsiteHostCandidate {
  host: string;
  hash: string;
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Returns the lowercase ASCII (punycode) host of an http(s) URL or bare host
 * name, or a reason it cannot be checked. IP literals and single-label hosts
 * are local addresses, as in the on-device lookup.
 */
export function normalizeWebsiteHost(
  input: string,
): { host: string } | { reason: "invalid-address" | "local-address" } {
  if (typeof input !== "string" || !input.trim() || input.length > 4096) {
    return { reason: "invalid-address" };
  }
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`,
    );
  } catch {
    return { reason: "invalid-address" };
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password
  ) {
    return { reason: "invalid-address" };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || /^[\d.]+$/.test(host) || host.startsWith("[")) {
    return { reason: "local-address" };
  }
  if (
    host.length > 253 ||
    !host.split(".").every((label) => LABEL.test(label))
  ) {
    return { reason: "invalid-address" };
  }
  return { host };
}

/** The host, then parent domains formed from its last six labels, down to two labels. */
export function websiteHostCandidates(host: string): string[] {
  const labels = host.split(".");
  const out = [host];
  for (
    let count = Math.min(labels.length - 1, MAX_SUFFIX_LABELS);
    count >= 2;
    count--
  ) {
    const suffix = labels.slice(-count).join(".");
    if (suffix !== host) out.push(suffix);
  }
  return out;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function websiteHostHashes(
  host: string,
): Promise<WebsiteHostCandidate[]> {
  return Promise.all(
    websiteHostCandidates(host).map(async (candidate) => ({
      host: candidate,
      hash: await sha256Hex(candidate),
    })),
  );
}

export function hashPrefix(
  hash: string,
  prefixBytes: number = WEBSITE_REPUTATION_DEFAULT_PREFIX_BYTES,
): string {
  return hash.slice(0, prefixBytes * 2);
}

const CATEGORY_TEXT: Record<WebsiteReputationCategory, string> = {
  phishing: "phishing",
  malware_or_scam: "malware or scam",
  fake_shop_or_scam: "fake shop or scam",
};

export function websiteReputationWarning(
  sources: string[],
  categories: WebsiteReputationCategory[],
): string {
  const detail = [
    sources.join(", "),
    categories.map((c) => CATEGORY_TEXT[c]).join(", "),
  ]
    .filter(Boolean)
    .join("; ");
  return `Known harmful site (${detail}): do not open or enter information.`;
}

/**
 * Builds a verdict from local candidate hashes and a lookup response. A hit on
 * any loaded list is `listed`. Without a hit, `not_listed` needs at least one
 * loaded list; otherwise the result is `unavailable`. List age is ignored.
 */
export function websiteReputationVerdict(
  host: string,
  candidates: WebsiteHostCandidate[],
  response: Pick<
    WebsiteReputationLookupResponse,
    "status" | "lists" | "matches"
  >,
): WebsiteReputationVerdict {
  const lists = new Map(response.lists.map((list) => [list.id, list]));
  for (const candidate of candidates) {
    const match = response.matches.find(
      (entry) => entry.hash === candidate.hash,
    );
    const listed = match?.lists
      .map((id) => lists.get(id))
      .filter(
        (list): list is WebsiteReputationListFreshness =>
          list?.status === "loaded",
      );
    if (listed?.length) {
      const sources = [...new Set(listed.map((list) => list.source))];
      const categories = [...new Set(listed.map((list) => list.category))];
      return {
        status: "listed",
        host,
        matchedHost: candidate.host,
        sources,
        categories,
        warning: websiteReputationWarning(sources, categories),
      };
    }
  }
  if (response.status !== "unavailable")
    return { status: "not_listed", host, label: "No known threat" };
  return { status: "unavailable", host, reason: "unavailable" };
}

export interface WebsiteReputationClientOptions {
  /** Eliza Cloud API origin, for example `https://www.elizacloud.ai`. */
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  prefixBytes?: number;
  timeoutMs?: number;
}

/**
 * Client for `POST /api/v1/website-reputation/lookup`. It sends only hash
 * prefixes. Any transport or server failure resolves to `unavailable`; it
 * never throws and never resolves to a safe result.
 */
export function createWebsiteReputationClient(
  options: WebsiteReputationClientOptions,
) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const prefixBytes =
    options.prefixBytes ?? WEBSITE_REPUTATION_DEFAULT_PREFIX_BYTES;
  if (
    !Number.isInteger(prefixBytes) ||
    prefixBytes < WEBSITE_REPUTATION_MIN_PREFIX_BYTES ||
    prefixBytes > WEBSITE_REPUTATION_MAX_PREFIX_BYTES
  ) {
    throw new Error("Invalid website reputation prefix length");
  }
  const endpoint = new URL(
    WEBSITE_REPUTATION_LOOKUP_PATH,
    options.baseUrl,
  ).toString();
  return {
    async check(address: string): Promise<WebsiteReputationVerdict> {
      const normalized = normalizeWebsiteHost(address);
      if ("reason" in normalized)
        return { status: "unavailable", host: null, reason: normalized.reason };
      const candidates = await websiteHostHashes(normalized.host);
      const body: WebsiteReputationLookupRequest = {
        prefixes: [
          ...new Set(candidates.map((c) => hashPrefix(c.hash, prefixBytes))),
        ],
      };
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": options.apiKey,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
        });
        if (!response.ok)
          return {
            status: "unavailable",
            host: normalized.host,
            reason: "unavailable",
          };
        const result =
          (await response.json()) as WebsiteReputationLookupResponse;
        if (!Array.isArray(result?.matches) || !Array.isArray(result?.lists)) {
          return {
            status: "unavailable",
            host: normalized.host,
            reason: "unavailable",
          };
        }
        return websiteReputationVerdict(normalized.host, candidates, result);
      } catch {
        return {
          status: "unavailable",
          host: normalized.host,
          reason: "unavailable",
        };
      }
    },
  };
}
