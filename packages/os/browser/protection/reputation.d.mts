/** One reviewed public feed; see `REPUTATION_FEEDS` in `policy.mjs`. */
export interface ReputationFeed {
  id: string;
  url: string;
  source: string;
  license?: string;
  licenseUrl?: string;
  threats: readonly string[];
  mirror?: boolean;
}

/**
 * `no-known-threat` never claims a site is safe: only that no loaded feed lists
 * the host. `unavailable` is never a clean result and never a block.
 */
export type ReputationVerdict =
  | {
      status: "blocked";
      source: string;
      scope: "domain";
      threats: readonly string[];
    }
  | { status: "no-known-threat"; source: string; scope: "domain" }
  | {
      status: "unavailable";
      reason: "invalid-address" | "local-address" | "feed-unavailable";
    };

export interface WebsiteReputationCheck {
  (address: string): Promise<ReputationVerdict>;
  warmup(): Promise<void>;
  start(): void;
  stop(): void;
}

export function createWebsiteReputation(options: {
  feeds: readonly ReputationFeed[];
  fetchImpl?: typeof fetch;
  now?: () => number;
  minEntries?: number;
  cacheDir?: string | null;
  userAgent?: string;
  waitForRefresh?: boolean;
}): WebsiteReputationCheck;
