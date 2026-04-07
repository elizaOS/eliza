import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ethers } from "ethers";
import type {
  DistributionAssetSelection,
  DistributionConfig,
  DistributionPlan,
  DistributionPublication,
  DistributionRecipient,
  HolderSnapshotEntry,
  PortfolioLifecycle,
  PortfolioPosition,
  TreasurySimulation,
} from "./types";

const ERC20_TRANSFER_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
] as const;

interface LoadedSnapshot {
  entries: HolderSnapshotEntry[];
  source: DistributionPlan["snapshotSource"];
  generatedAt: string | null;
  blockNumber: number | null;
  note: string;
}

function absolutePath(filePath: string): string {
  return path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);
}

async function loadSnapshotEntries(
  snapshotPath: string,
): Promise<HolderSnapshotEntry[]> {
  try {
    const content = await readFile(absolutePath(snapshotPath), "utf8");
    const parsed = JSON.parse(content) as HolderSnapshotEntry[];
    return parsed.filter(
      (entry) => entry.address && typeof entry.balance === "number",
    );
  } catch {
    return [];
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  const resolved = absolutePath(filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, JSON.stringify(value, null, 2), "utf8");
}

function normalizeAddress(value: string): string {
  return value.toLowerCase();
}

async function loadOnchainSnapshot(
  config: DistributionConfig,
  rpcUrl: string,
): Promise<LoadedSnapshot> {
  if (!config.holderTokenAddress) {
    return {
      entries: [],
      source: "none",
      generatedAt: null,
      blockNumber: null,
      note: "Distribution token address is missing, so on-chain holder snapshot cannot run.",
    };
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const tokenAddress = normalizeAddress(config.holderTokenAddress);
  const contract = new ethers.Contract(
    tokenAddress,
    ERC20_TRANSFER_ABI,
    provider,
  );
  const transferTopic = ethers.id("Transfer(address,address,uint256)");
  const latestBlock = await provider.getBlockNumber();
  const fromBlock = Math.max(0, config.startBlock ?? 0);
  const step = 5_000;
  const holders = new Set<string>();
  const zeroAddress = "0x0000000000000000000000000000000000000000";

  for (let start = fromBlock; start <= latestBlock; start += step + 1) {
    const end = Math.min(latestBlock, start + step);
    const logs = await provider.getLogs({
      address: tokenAddress,
      topics: [transferTopic],
      fromBlock: start,
      toBlock: end,
    });

    for (const log of logs) {
      const parsed = contract.interface.parseLog(log);
      if (!parsed) continue;
      const from = normalizeAddress(String(parsed.args.from));
      const to = normalizeAddress(String(parsed.args.to));
      if (from !== zeroAddress) holders.add(from);
      if (to !== zeroAddress) holders.add(to);
    }
  }

  const decimalsRaw = await contract.decimals();
  const decimals = Number(decimalsRaw);
  const addresses = Array.from(holders);
  const balances: HolderSnapshotEntry[] = [];

  for (let index = 0; index < addresses.length; index += 40) {
    const chunk = addresses.slice(index, index + 40);
    const chunkBalances = await Promise.all(
      chunk.map(async (address) => {
        const rawBalance = (await contract.balanceOf(address)) as bigint;
        if (rawBalance <= 0n) return null;
        return {
          address,
          balance: Number.parseFloat(ethers.formatUnits(rawBalance, decimals)),
        } satisfies HolderSnapshotEntry;
      }),
    );
    balances.push(
      ...chunkBalances.filter(
        (entry): entry is HolderSnapshotEntry => entry !== null,
      ),
    );
  }

  balances.sort((a, b) => b.balance - a.balance);
  await writeJsonFile(config.snapshotPath, balances);

  return {
    entries: balances,
    source: "onchain",
    generatedAt: new Date().toISOString(),
    blockNumber: latestBlock,
    note: `On-chain snapshot rebuilt from Transfer logs through block ${latestBlock}.`,
  };
}

async function loadSnapshot(
  config: DistributionConfig,
  rpcUrl: string | null,
): Promise<LoadedSnapshot> {
  if (config.holderTokenAddress && rpcUrl) {
    try {
      return await loadOnchainSnapshot(config, rpcUrl);
    } catch (error) {
      const fallbackEntries = await loadSnapshotEntries(config.snapshotPath);
      return {
        entries: fallbackEntries,
        source: fallbackEntries.length > 0 ? "file" : "none",
        generatedAt: null,
        blockNumber: null,
        note:
          fallbackEntries.length > 0
            ? `On-chain snapshot failed, so distribution fell back to the file snapshot. ${String(error)}`
            : `On-chain snapshot failed and no fallback file snapshot was available. ${String(error)}`,
      };
    }
  }

  const entries = await loadSnapshotEntries(config.snapshotPath);
  return {
    entries,
    source: entries.length > 0 ? "file" : "none",
    generatedAt: null,
    blockNumber: null,
    note:
      entries.length > 0
        ? "Distribution is using the configured file snapshot."
        : "No holder snapshot data is available yet.",
  };
}

function buildRecipients(
  holders: HolderSnapshotEntry[],
  distributionPoolUsd: number,
  maxRecipients: number,
): DistributionRecipient[] {
  const selected = holders.slice(0, maxRecipients);
  const totalBalance = selected.reduce(
    (sum, holder) => sum + holder.balance,
    0,
  );

  return selected.map((holder) => {
    const allocationUsd =
      totalBalance > 0
        ? Math.round((distributionPoolUsd * holder.balance) / totalBalance)
        : 0;
    const allocationPct =
      distributionPoolUsd > 0
        ? Math.round((allocationUsd / distributionPoolUsd) * 1000) / 10
        : 0;

    return {
      address: holder.address,
      label: holder.label,
      balance: holder.balance,
      allocationUsd,
      allocationPct,
      allocationBps:
        totalBalance > 0
          ? Math.round((holder.balance / totalBalance) * 10_000)
          : 0,
    };
  });
}

function parseNumber(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatTokenAmount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1) return value.toFixed(6).replace(/\.?0+$/, "");
  return value.toFixed(12).replace(/\.?0+$/, "");
}

function portfolioSharePct(
  position: PortfolioPosition,
  portfolioLifecycle: PortfolioLifecycle,
): number {
  const denominator =
    portfolioLifecycle.grossPortfolioValueUsd ||
    portfolioLifecycle.totalCurrentValueUsd ||
    0;
  const currentQuoteUsd =
    position.walletQuoteUsd ?? position.currentValueUsd ?? 0;
  if (denominator <= 0 || currentQuoteUsd <= 0) return 0;
  return (currentQuoteUsd / denominator) * 100;
}

function buildSelectedAsset(
  config: DistributionConfig,
  distributionPoolUsd: number,
  portfolioLifecycle: PortfolioLifecycle,
): DistributionAssetSelection {
  if (config.execution.assetTokenAddress && config.execution.assetTotalAmount) {
    return {
      mode: "manual",
      tokenAddress: config.execution.assetTokenAddress,
      tokenSymbol: null,
      totalAmount: config.execution.assetTotalAmount,
      walletBalance: null,
      walletQuoteUsd: null,
      sourcePositionTokenAddress: null,
      reason: "Using the manually configured distribution asset and amount.",
    };
  }

  if (!config.execution.autoSelectAsset) {
    return {
      mode: "none",
      tokenAddress: null,
      tokenSymbol: null,
      totalAmount: null,
      walletBalance: null,
      walletQuoteUsd: null,
      sourcePositionTokenAddress: null,
      reason:
        "Automatic asset selection is disabled and no manual asset override was provided.",
    };
  }

  const evaluations = portfolioLifecycle.activePositions.map((position) => {
    const reasons: string[] = [];
    const walletBalance = parseNumber(position.walletTokenBalance);
    const walletQuoteUsd = position.walletQuoteUsd ?? 0;
    const sharePct = portfolioSharePct(position, portfolioLifecycle);

    if (position.executionSource === "paper") {
      reasons.push("paper-only position");
    }
    if (
      config.execution.requireVerifiedWallet &&
      position.walletVerification !== "present"
    ) {
      reasons.push(`wallet verification is ${position.walletVerification}`);
    }
    if (walletBalance === null || walletBalance <= 0) {
      reasons.push("wallet balance is empty");
    }
    if (walletQuoteUsd <= 0) {
      reasons.push("wallet quote is unavailable");
    }
    if (walletQuoteUsd < config.execution.minWalletQuoteUsd) {
      reasons.push(
        `wallet quote ${Math.round(walletQuoteUsd)} is below ${config.execution.minWalletQuoteUsd} USD`,
      );
    }
    if (config.execution.requirePositivePnl && position.unrealizedPnlUsd <= 0) {
      reasons.push(
        `unrealized PnL ${Math.round(position.unrealizedPnlUsd)} is not positive`,
      );
    }
    if (
      config.execution.requireTakeProfitHit &&
      position.takeProfitCount <= 0
    ) {
      reasons.push("no take-profit stage has been hit yet");
    }
    if (sharePct < config.execution.minPortfolioSharePct) {
      reasons.push(
        `portfolio share ${sharePct.toFixed(1)}% is below ${config.execution.minPortfolioSharePct}%`,
      );
    }

    return {
      position,
      walletBalance,
      walletQuoteUsd,
      sharePct,
      qualifies: reasons.length === 0,
      reasons,
    };
  });

  const selected = evaluations
    .filter((entry) => entry.qualifies)
    .sort((a, b) => b.walletQuoteUsd - a.walletQuoteUsd)[0];
  if (!selected) {
    const rejectedPreview = evaluations
      .slice(0, 4)
      .map(
        (entry) =>
          `${entry.position.tokenSymbol}: ${entry.reasons.join(", ") || "did not qualify"}`,
      )
      .join(" | ");
    return {
      mode: "none",
      tokenAddress: null,
      tokenSymbol: null,
      totalAmount: null,
      walletBalance: null,
      walletQuoteUsd: null,
      sourcePositionTokenAddress: null,
      reason: rejectedPreview
        ? `No treasury position passed the current distribution asset policy. ${rejectedPreview}`
        : "No live wallet-backed treasury position currently has enough balance and quote data for automatic distribution asset selection.",
    };
  }

  const walletBalance = selected.walletBalance ?? 0;
  const walletQuoteUsd = selected.walletQuoteUsd;
  const ratio =
    walletQuoteUsd > 0
      ? Math.max(0, Math.min(1, distributionPoolUsd / walletQuoteUsd))
      : 0;
  const totalAmount = walletBalance * ratio;
  if (totalAmount <= 0) {
    return {
      mode: "none",
      tokenAddress: null,
      tokenSymbol: null,
      totalAmount: null,
      walletBalance: selected.position.walletTokenBalance,
      walletQuoteUsd: selected.position.walletQuoteUsd,
      sourcePositionTokenAddress: selected.position.tokenAddress,
      reason: `Automatic selection found ${selected.position.tokenSymbol}, but the computed distribution amount was zero.`,
    };
  }

  return {
    mode: "auto",
    tokenAddress: selected.position.tokenAddress,
    tokenSymbol: selected.position.tokenSymbol,
    totalAmount: formatTokenAmount(totalAmount),
    walletBalance: selected.position.walletTokenBalance,
    walletQuoteUsd: selected.position.walletQuoteUsd,
    sourcePositionTokenAddress: selected.position.tokenAddress,
    reason: `Auto-selected ${selected.position.tokenSymbol} from a policy-qualified treasury position with ${selected.sharePct.toFixed(1)}% portfolio share and ${Math.round(selected.walletQuoteUsd)} USD wallet quote.`,
  };
}

function buildPublication(
  plan: Omit<DistributionPlan, "publication">,
  generatedAt: string,
): DistributionPublication | null {
  if (!plan.enabled || plan.recipients.length === 0) {
    return null;
  }

  const snapshotResolvedPath = absolutePath(plan.snapshotPath);
  const publicationPath = path.join(
    path.dirname(snapshotResolvedPath),
    "distribution-publication.md",
  );
  const manifestPath = path.join(
    path.dirname(snapshotResolvedPath),
    "distribution-manifest.json",
  );
  const topRows = plan.recipients
    .slice(0, 10)
    .map(
      (recipient, index) =>
        `${index + 1}. \`${recipient.address}\` - ${recipient.balance.toLocaleString()} tokens - ${recipient.allocationPct}%`,
    );
  const title = `ElizaOK Distribution Preview ${generatedAt}`;
  const markdown = [
    `# ${title}`,
    ``,
    `- Snapshot source: \`${plan.snapshotSource}\``,
    `- Snapshot path: \`${snapshotResolvedPath}\``,
    `- Snapshot block: \`${plan.snapshotBlockNumber ?? "n/a"}\``,
    `- Holder token: \`${plan.holderTokenAddress ?? "n/a"}\``,
    `- Distribution asset mode: \`${plan.selectedAsset.mode}\``,
    `- Distribution asset token: \`${plan.selectedAsset.tokenAddress ?? "n/a"}\``,
    `- Distribution asset symbol: \`${plan.selectedAsset.tokenSymbol ?? "n/a"}\``,
    `- Distribution total amount: \`${plan.selectedAsset.totalAmount ?? "n/a"}\``,
    `- Eligible holders: \`${plan.eligibleHolderCount}\``,
    `- Distribution pool: \`$${plan.distributionPoolUsd}\``,
    `- Max recipients: \`${plan.maxRecipients}\``,
    ``,
    `## Recipient Preview`,
    ``,
    ...(topRows.length > 0 ? topRows : ["No recipients selected."]),
    ``,
    `## Operator Note`,
    ``,
    plan.note,
    ``,
    `## Manifest`,
    ``,
    `Use \`${manifestPath}\` as the machine-readable allocation file for downstream airdrop execution.`,
    ``,
  ].join("\n");

  return {
    title,
    markdown,
    announcement: `ElizaOK distribution preview is ready with ${plan.eligibleHolderCount} eligible holders and a $${plan.distributionPoolUsd} allocation pool.`,
    publicationPath,
    manifestPath,
  };
}

export async function buildDistributionPlan(
  config: DistributionConfig,
  treasurySimulation: TreasurySimulation,
  rpcUrl: string | null,
  portfolioLifecycle: PortfolioLifecycle,
): Promise<DistributionPlan> {
  const distributionPoolUsd = Math.round(
    (treasurySimulation.allocatedUsd *
      Math.max(0, Math.min(100, config.poolPct))) /
      100,
  );

  const snapshot = await loadSnapshot(config, rpcUrl);
  const eligible = snapshot.entries
    .filter((entry) => entry.balance >= config.minEligibleBalance)
    .sort((a, b) => b.balance - a.balance);
  const selectedAsset = buildSelectedAsset(
    config,
    distributionPoolUsd,
    portfolioLifecycle,
  );

  const planWithoutPublication: Omit<DistributionPlan, "publication"> = {
    enabled: config.enabled,
    holderTokenAddress: config.holderTokenAddress,
    snapshotPath: config.snapshotPath,
    snapshotSource: snapshot.source,
    snapshotGeneratedAt: snapshot.generatedAt,
    snapshotBlockNumber: snapshot.blockNumber,
    minEligibleBalance: config.minEligibleBalance,
    eligibleHolderCount: eligible.length,
    totalQualifiedBalance: eligible.reduce(
      (sum, entry) => sum + entry.balance,
      0,
    ),
    distributionPoolUsd,
    maxRecipients: config.maxRecipients,
    selectedAsset,
    note: config.enabled
      ? eligible.length > 0
        ? `${snapshot.note} Recipients are allocated proportionally from the qualified holder set. ${selectedAsset.reason}`
        : `${snapshot.note} Distribution is enabled, but no eligible holders were found.`
      : "Distribution planning is disabled. Enable it and provide a holder token or snapshot to build the airdrop manifest.",
    recipients: config.enabled
      ? buildRecipients(eligible, distributionPoolUsd, config.maxRecipients)
      : [],
  };

  const publication = buildPublication(
    planWithoutPublication,
    new Date().toISOString(),
  );
  if (publication?.manifestPath) {
    await writeJsonFile(publication.manifestPath, {
      generatedAt: new Date().toISOString(),
      holderTokenAddress: planWithoutPublication.holderTokenAddress,
      snapshotPath: absolutePath(planWithoutPublication.snapshotPath),
      snapshotSource: planWithoutPublication.snapshotSource,
      snapshotBlockNumber: planWithoutPublication.snapshotBlockNumber,
      selectedAsset: planWithoutPublication.selectedAsset,
      minEligibleBalance: planWithoutPublication.minEligibleBalance,
      eligibleHolderCount: planWithoutPublication.eligibleHolderCount,
      distributionPoolUsd: planWithoutPublication.distributionPoolUsd,
      recipients: planWithoutPublication.recipients,
      note: planWithoutPublication.note,
    });
  }
  if (publication?.publicationPath) {
    await mkdir(path.dirname(publication.publicationPath), { recursive: true });
    await writeFile(publication.publicationPath, publication.markdown, "utf8");
  }

  return {
    ...planWithoutPublication,
    publication,
  };
}
