export interface NetworkConsentEntry {
  project: string;
  /** Service-owned app scope; absent/null is the shared line. */
  app?: "ntwrk" | "slop" | "peon" | "friends" | null;
  channel: "telegram" | "blooio" | "twilio" | "whatsapp";
  address: string;
  state: "opted_in" | "opted_out";
  /** `keyword:STOP`, `keyword:START`, `invite_acceptance`, `admin`, ... */
  source: string;
  providerMessageId?: string;
  at: string;
}

/** Current consent state per (project, address), plus an append-only history. */
export interface NetworkConsentLedger {
  current(
    project: string,
    address: string,
    app?: NetworkConsentEntry["app"],
  ): Promise<NetworkConsentEntry | null>;
  record(entry: NetworkConsentEntry): Promise<void>;
}

export const CONSENT_HISTORY_LIMIT = 200;

/** Addresses are phone numbers or handles; case and whitespace never matter. */
export function consentAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function parseConsentEntry(value: unknown): NetworkConsentEntry | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      // error-policy:J3 an unreadable ledger row is treated as no consent row.
      return null;
    }
  }
  if (!candidate || typeof candidate !== "object") return null;
  const entry = candidate as Record<string, unknown>;
  if (
    typeof entry.project !== "string" ||
    typeof entry.address !== "string" ||
    (entry.state !== "opted_in" && entry.state !== "opted_out") ||
    typeof entry.source !== "string" ||
    typeof entry.at !== "string" ||
    !Number.isFinite(Date.parse(entry.at)) ||
    (entry.app !== undefined &&
      entry.app !== null &&
      !["ntwrk", "slop", "peon", "friends"].includes(String(entry.app)))
  ) {
    return null;
  }
  return entry as unknown as NetworkConsentEntry;
}

export class NetworkConsentStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkConsentStateError";
  }
}
/** Captures the selected remote authority; an outage never falls back to Redis. */
export function cloudflareNetworkConsentLedger(
  env: Record<string, string | undefined>,
  fetcher: (url: URL, init: RequestInit) => Promise<Response> = fetch,
): NetworkConsentLedger {
  const token = env.NETWORK_CONSENT_TOKEN;
  let endpoint: URL;
  try {
    endpoint = new URL(env.NETWORK_CONSENT_URL ?? "");
  } catch {
    throw new NetworkConsentStateError("NETWORK_CONSENT_URL is required");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/internal/network-consent" ||
    !token?.trim()
  )
    throw new NetworkConsentStateError(
      "Invalid Network consent authority configuration",
    );
  async function call(input: object): Promise<unknown> {
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });
    if (!response.ok)
      throw new NetworkConsentStateError(
        `Network consent state failed (${response.status})`,
      );
    return response.json();
  }
  return {
    async current(project, address, app) {
      const result = await call({
        operation: "current",
        project,
        address: consentAddress(address),
        app,
      });
      if (result === null) return null;
      const entry = parseConsentEntry(result);
      if (
        !entry ||
        entry.project !== project ||
        entry.address !== consentAddress(address) ||
        (entry.app ?? null) !== (app ?? null)
      )
        throw new NetworkConsentStateError("Invalid Network consent receipt");
      return entry;
    },
    async record(entry) {
      if (!parseConsentEntry(entry))
        throw new NetworkConsentStateError("Invalid Network consent entry");
      const result = await call({
        operation: "record",
        project: entry.project,
        address: consentAddress(entry.address),
        entry: {
          ...entry,
          address: consentAddress(entry.address),
          at: new Date(entry.at).toISOString(),
        },
      });
      if (
        !result ||
        typeof result !== "object" ||
        !("accepted" in result) ||
        result.accepted !== true
      )
        throw new NetworkConsentStateError(
          "Network consent write not acknowledged",
        );
    },
  };
}
