import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RouteRequestMeta } from "@elizaos/core";
import type { RouteHelpers } from "@elizaos/shared";
import { readJsonFile } from "../utils/atomic-json.js";

function emptyMerkleRoot(): string {
  return createHash("sha256").update("", "utf8").digest("hex");
}

type NfaPlugin = {
  buildMerkleRoot: (leafHashes: string[]) => string;
  parseLearnings: (markdown: string) => Array<{ hash: string }>;
  sha256: (data: string) => string;
};

let nfaPlugin: NfaPlugin | null | undefined;

async function getNfaPlugin(): Promise<NfaPlugin | null> {
  if (nfaPlugin !== undefined) return nfaPlugin;
  try {
    const pkgName = "@elizaos/plugin-bnb-identity";
    const mod = await import(/* @vite-ignore */ pkgName);
    nfaPlugin =
      typeof mod?.buildMerkleRoot === "function" &&
      typeof mod?.parseLearnings === "function" &&
      typeof mod?.sha256 === "function"
        ? {
            buildMerkleRoot: mod.buildMerkleRoot,
            parseLearnings: mod.parseLearnings,
            sha256: mod.sha256,
          }
        : null;
  } catch {
    nfaPlugin = null;
  }
  return nfaPlugin;
}

export interface NfaRouteContext
  extends RouteRequestMeta,
    Pick<RouteHelpers, "json" | "error"> {}

interface NfaRecord {
  tokenId: string;
  contractAddress: string;
  network: string;
  ownerAddress: string;
  mintTxHash: string;
  merkleRoot: string;
  mintedAt: string;
  lastUpdatedAt: string;
}

interface IdentityRecord {
  agentId: string;
  network: string;
  txHash: string;
  ownerAddress: string;
  agentURI: string;
  registeredAt: string;
  lastUpdatedAt: string;
}

export async function handleNfaRoutes(ctx: NfaRouteContext): Promise<boolean> {
  const { res, method, pathname, json } = ctx;

  if (method === "GET" && pathname === "/api/nfa/status") {
    const elizaDir = join(homedir(), ".eliza");
    const [nfaRecord, identityRecord] = await Promise.all([
      readJsonFile<NfaRecord>(join(elizaDir, "bap578-nfa.json")),
      readJsonFile<IdentityRecord>(join(elizaDir, "bnb-identity.json")),
    ]);

    const bscscanBase =
      (nfaRecord?.network ?? identityRecord?.network ?? "bsc-testnet") === "bsc"
        ? "https://bscscan.com"
        : "https://testnet.bscscan.com";

    json(res, {
      nfa: nfaRecord
        ? {
            tokenId: nfaRecord.tokenId,
            contractAddress: nfaRecord.contractAddress,
            network: nfaRecord.network,
            ownerAddress: nfaRecord.ownerAddress,
            merkleRoot: nfaRecord.merkleRoot,
            mintTxHash: nfaRecord.mintTxHash,
            mintedAt: nfaRecord.mintedAt,
            lastUpdatedAt: nfaRecord.lastUpdatedAt,
            bscscanUrl: `${bscscanBase}/tx/${nfaRecord.mintTxHash}`,
          }
        : null,
      identity: identityRecord
        ? {
            agentId: identityRecord.agentId,
            network: identityRecord.network,
            ownerAddress: identityRecord.ownerAddress,
            agentURI: identityRecord.agentURI,
            registeredAt: identityRecord.registeredAt,
            scanUrl: `https://${identityRecord.network === "bsc" ? "www" : "testnet"}.8004scan.io/agent/${identityRecord.agentId}`,
          }
        : null,
      configured: !!(nfaRecord || identityRecord),
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/nfa/learnings") {
    const learningsPaths = [
      join(homedir(), ".eliza", "LEARNINGS.md"),
      join(process.cwd(), "LEARNINGS.md"),
    ];

    let markdown: string | null = null;
    let resolvedSource: string | null = null;
    for (const path of learningsPaths) {
      try {
        markdown = await readFile(path, "utf8");
        resolvedSource = path;
        break;
      } catch {}
    }

    if (!markdown) {
      json(res, {
        entries: [],
        merkleRoot: emptyMerkleRoot(),
        totalEntries: 0,
        source: null,
      });
      return true;
    }

    const plugin = await getNfaPlugin();
    if (!plugin) {
      json(res, {
        entries: [],
        merkleRoot: emptyMerkleRoot(),
        totalEntries: 0,
        source: null,
      });
      return true;
    }

    const entries = plugin.parseLearnings(markdown);
    const leafHashes = entries.map((entry) => entry.hash);
    const merkleRoot = plugin.buildMerkleRoot(leafHashes);

    json(res, {
      entries,
      merkleRoot,
      totalEntries: entries.length,
      source: resolvedSource,
    });
    return true;
  }

  return false;
}
