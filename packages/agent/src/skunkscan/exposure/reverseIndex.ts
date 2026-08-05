import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SupportedChain, WalletRelationshipDirection } from "../types";

// The reverse-index inverts the usual exposure check. Instead of asking
// "does this wallet's own (sampled) history touch a flagged registry
// address," this precomputes "every address that has ever transacted
// with a flagged registry address" by fully scanning each flagged
// address's own history once (see buildReverseIndex.ts). Checking a
// newly-investigated wallet against this becomes an O(1) lookup, giving
// exposure coverage independent of that wallet's own sample depth.
//
// This file only defines the shape and the lookup - buildReverseIndex.ts
// is the (manually-run, for now) script that actually populates
// reverseIndex.generated.json.

export type ScanStatus = "complete" | "capped" | "failed";

export type RegistryAddressScanCoverage = {
  flaggedAddress: string;
  chain: SupportedChain;

  status: ScanStatus;

  transactionsScanned: number;

  // How far BACK coverage reaches - the completeness signal. Null until
  // at least one page has been scanned.
  oldestScannedBlock: number | null;
  oldestScannedAt: string | null;

  // The most recent point scanned, regardless of status - what an
  // incremental refresh uses to fetch only newer transactions next time.
  newestScannedBlock: number | null;
  newestScannedAt: string | null;

  lastRefreshedAt: string;

  // Set only when status === "capped": we chose to stop (size/time cap),
  // real partial data is present.
  cappedReason: string | null;

  // Set only when status === "failed": the provider wouldn't cooperate
  // (e.g. persistent errors) - distinct from choosing to stop. No new
  // data from this run; whatever coverage existed before is unchanged.
  failureReason: string | null;
};

export type ReverseIndexMatch = {
  flaggedAddress: string;
  direction: WalletRelationshipDirection;
  contributesToScore: boolean;
  transactionSignatures: string[];
  lastSeenAt: number;
};

export type ReverseExposureIndexEntry = {
  address: string;
  matches: ReverseIndexMatch[];
};

type ReverseIndexFile = {
  generatedAt: string;
  index: Partial<
    Record<SupportedChain, Record<string, ReverseExposureIndexEntry>>
  >;
  coverage: Partial<
    Record<SupportedChain, Record<string, RegistryAddressScanCoverage>>
  >;
};

const EMPTY_FILE: ReverseIndexFile = {
  generatedAt: "never",
  index: {},
  coverage: {},
};

function loadReverseIndexFile(): ReverseIndexFile {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(
      path.join(here, "reverseIndex.generated.json"),
      "utf8",
    );

    return JSON.parse(raw) as ReverseIndexFile;
  } catch {
    // No generated file yet (e.g. buildReverseIndex.ts hasn't been run) -
    // degrade to "no reverse-index matches" rather than throwing, the
    // same "honest partial" approach used elsewhere in this codebase.
    return EMPTY_FILE;
  }
}

const typedReverseIndexFile = loadReverseIndexFile();

export function lookupReverseExposureIndex(
  chain: SupportedChain,
  address: string | null | undefined,
): ReverseExposureIndexEntry | null {
  if (!address) {
    return null;
  }

  const chainIndex = typedReverseIndexFile.index[chain];

  if (!chainIndex) {
    return null;
  }

  // Same lowercase-only-for-ethereum convention as the static exposure
  // registry: Solana addresses are base58 and case-sensitive (no
  // alternate valid casing for the same address to normalize between);
  // Ethereum addresses are checksummed by convention from most providers
  // but stored lowercase here.
  const normalizedAddress =
    chain === "ethereum" ? address.toLowerCase() : address;

  return chainIndex[normalizedAddress] ?? null;
}

export function getRegistryAddressScanCoverage(
  chain: SupportedChain,
  flaggedAddress: string,
): RegistryAddressScanCoverage | null {
  const chainCoverage = typedReverseIndexFile.coverage[chain];

  if (!chainCoverage) {
    return null;
  }

  const normalizedAddress =
    chain === "ethereum" ? flaggedAddress.toLowerCase() : flaggedAddress;

  return chainCoverage[normalizedAddress] ?? null;
}
