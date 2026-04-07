import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ethers } from "ethers";
import type {
  DistributionConfig,
  DistributionExecutionLedger,
  DistributionExecutionRecord,
  DistributionExecutionState,
  DistributionPlan,
} from "./types";

const ERC20_AIRDROP_ABI = [
  "function decimals() view returns (uint8)",
  "function transfer(address to, uint256 amount) returns (bool)",
] as const;

interface ManifestShape {
  recipients: Array<{
    address: string;
    allocationBps: number;
  }>;
}

interface RecipientAllocation {
  address: string;
  allocationBps: number;
  amountRaw: bigint;
}

function absolutePath(filePath: string): string {
  return path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);
}

async function loadLedger(
  reportsDir: string,
): Promise<DistributionExecutionLedger> {
  const ledgerPath = path.join(
    absolutePath(reportsDir),
    "distribution-ledger.json",
  );
  try {
    const content = await readFile(ledgerPath, "utf8");
    return JSON.parse(content) as DistributionExecutionLedger;
  } catch {
    return {
      records: [],
      lastUpdatedAt: null,
      totalRecipientsExecuted: 0,
      totalRecipientsDryRun: 0,
    };
  }
}

async function saveLedger(
  reportsDir: string,
  ledger: DistributionExecutionLedger,
): Promise<string> {
  const ledgerPath = path.join(
    absolutePath(reportsDir),
    "distribution-ledger.json",
  );
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await writeFile(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");
  return ledgerPath;
}

function appendRecord(
  ledger: DistributionExecutionLedger,
  record: Omit<DistributionExecutionRecord, "id">,
): DistributionExecutionLedger {
  const next: DistributionExecutionRecord = { id: randomUUID(), ...record };
  return {
    records: [next, ...ledger.records].slice(0, 500),
    lastUpdatedAt: record.generatedAt,
    totalRecipientsExecuted:
      ledger.totalRecipientsExecuted +
      (record.disposition === "executed" ? 1 : 0),
    totalRecipientsDryRun:
      ledger.totalRecipientsDryRun + (record.disposition === "dry_run" ? 1 : 0),
  };
}

function buildFingerprint(
  assetTokenAddress: string,
  assetTotalAmount: string,
  recipients: ManifestShape["recipients"],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        assetTokenAddress: assetTokenAddress.toLowerCase(),
        assetTotalAmount,
        recipients: recipients.map((recipient) => ({
          address: recipient.address.toLowerCase(),
          allocationBps: recipient.allocationBps,
        })),
      }),
    )
    .digest("hex");
}

function buildRecipientAllocations(
  recipients: ManifestShape["recipients"],
  totalAmountRaw: bigint,
): RecipientAllocation[] {
  let allocated = 0n;
  return recipients.map((recipient, index) => {
    const isLast = index === recipients.length - 1;
    const amountRaw = isLast
      ? totalAmountRaw - allocated
      : (totalAmountRaw * BigInt(recipient.allocationBps)) / 10_000n;
    allocated += amountRaw;
    return {
      address: recipient.address,
      allocationBps: recipient.allocationBps,
      amountRaw,
    };
  });
}

export async function executeDistributionLane({
  config,
  distributionPlan,
  reportsDir,
  rpcUrl,
}: {
  config: DistributionConfig;
  distributionPlan: DistributionPlan;
  reportsDir: string;
  rpcUrl: string | null;
}): Promise<{
  distributionExecution: DistributionExecutionState;
  distributionLedger: DistributionExecutionLedger;
}> {
  let distributionLedger = await loadLedger(reportsDir);
  const execution = config.execution;
  const manifestPath = distributionPlan.publication?.manifestPath ?? null;
  const effectiveAssetTokenAddress =
    execution.assetTokenAddress || distributionPlan.selectedAsset.tokenAddress;
  const effectiveAssetTotalAmount =
    execution.assetTotalAmount || distributionPlan.selectedAsset.totalAmount;
  const readinessChecks = [
    {
      label: "Execution enabled",
      ready: execution.enabled,
      detail: execution.enabled
        ? "Airdrop execution lane is enabled."
        : "Enable ELIZAOK_DISTRIBUTION_EXECUTION_ENABLED.",
    },
    {
      label: "Distribution plan available",
      ready:
        distributionPlan.enabled &&
        distributionPlan.recipients.length > 0 &&
        Boolean(manifestPath),
      detail:
        distributionPlan.enabled &&
        distributionPlan.recipients.length > 0 &&
        manifestPath
          ? "Distribution manifest is available."
          : "Generate a non-empty distribution plan first.",
    },
    {
      label: "BNB RPC configured",
      ready: Boolean(rpcUrl),
      detail: rpcUrl ? "BNB RPC is configured." : "Add ELIZAOK_BSC_RPC_URL.",
    },
    {
      label: "Asset token configured",
      ready: Boolean(effectiveAssetTokenAddress),
      detail: effectiveAssetTokenAddress
        ? execution.assetTokenAddress
          ? "Airdrop asset token is configured manually."
          : `Airdrop asset token was auto-selected from treasury position ${distributionPlan.selectedAsset.tokenSymbol || distributionPlan.selectedAsset.tokenAddress}.`
        : "Add ELIZAOK_DISTRIBUTION_ASSET_TOKEN_ADDRESS or allow auto-selection to find a live treasury asset.",
    },
    {
      label: "Asset total amount configured",
      ready: Boolean(effectiveAssetTotalAmount),
      detail: effectiveAssetTotalAmount
        ? execution.assetTotalAmount
          ? "Airdrop asset total amount is configured manually."
          : "Airdrop asset total amount was auto-sized from the selected treasury position."
        : "Add ELIZAOK_DISTRIBUTION_ASSET_TOTAL_AMOUNT or provide enough live treasury data for auto-sizing.",
    },
    {
      label: "Wallet configured for live mode",
      ready:
        execution.dryRun ||
        (Boolean(execution.walletAddress) &&
          Boolean(execution.privateKey) &&
          execution.liveConfirmArmed),
      detail: execution.dryRun
        ? "Dry-run mode does not require live wallet confirmation."
        : execution.walletAddress &&
            execution.privateKey &&
            execution.liveConfirmArmed
          ? "Live airdrop wallet is configured and manually armed."
          : `Add wallet credentials and set ELIZAOK_DISTRIBUTION_LIVE_CONFIRM=${execution.liveConfirmPhrase}.`,
    },
  ];
  const readinessScore = readinessChecks.filter((item) => item.ready).length;
  const readinessTotal = readinessChecks.length;
  const configured = readinessChecks.every((item, index) =>
    index === 0 ? true : item.ready,
  );
  const baseState: DistributionExecutionState = {
    enabled: execution.enabled,
    dryRun: execution.dryRun,
    configured,
    liveExecutionArmed: execution.liveConfirmArmed,
    readinessScore,
    readinessTotal,
    readinessChecks,
    nextAction:
      readinessChecks.find((item) => !item.ready)?.detail ||
      "Distribution execution is ready.",
    assetTokenAddress: effectiveAssetTokenAddress,
    assetTotalAmount: effectiveAssetTotalAmount,
    walletAddress: execution.walletAddress,
    manifestPath,
    manifestFingerprint: null,
    maxRecipientsPerRun: execution.maxRecipientsPerRun,
    cycleSummary: {
      attemptedCount: 0,
      dryRunCount: 0,
      executedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      note: "Distribution execution did not run.",
    },
  };

  if (!execution.enabled) {
    return { distributionExecution: baseState, distributionLedger };
  }
  if (
    !configured ||
    !manifestPath ||
    !rpcUrl ||
    !effectiveAssetTokenAddress ||
    !effectiveAssetTotalAmount
  ) {
    return { distributionExecution: baseState, distributionLedger };
  }

  const manifest = JSON.parse(
    await readFile(absolutePath(manifestPath), "utf8"),
  ) as ManifestShape;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer =
    execution.dryRun || !execution.privateKey
      ? null
      : new ethers.Wallet(execution.privateKey, provider);
  const contract = new ethers.Contract(
    effectiveAssetTokenAddress,
    ERC20_AIRDROP_ABI,
    signer ?? provider,
  );
  const decimalsRaw = await contract.decimals();
  const decimals = Number(decimalsRaw);
  const totalAmountRaw = ethers.parseUnits(effectiveAssetTotalAmount, decimals);
  const manifestFingerprint = buildFingerprint(
    effectiveAssetTokenAddress,
    effectiveAssetTotalAmount,
    manifest.recipients,
  );
  const recipientAllocations = buildRecipientAllocations(
    manifest.recipients,
    totalAmountRaw,
  );
  const recipients = recipientAllocations
    .filter(
      (recipient) =>
        execution.dryRun ||
        !distributionLedger.records.some(
          (record) =>
            record.manifestFingerprint === manifestFingerprint &&
            record.recipientAddress.toLowerCase() ===
              recipient.address.toLowerCase() &&
            record.disposition === "executed",
        ),
    )
    .slice(0, execution.maxRecipientsPerRun);
  const state: DistributionExecutionState = {
    ...baseState,
    manifestFingerprint,
    cycleSummary: {
      ...baseState.cycleSummary,
      note: "Distribution manifest loaded and awaiting execution.",
    },
  };

  if (recipients.length === 0) {
    return {
      distributionExecution: {
        ...state,
        cycleSummary: {
          ...state.cycleSummary,
          note: "No recipients were present in the manifest.",
        },
      },
      distributionLedger,
    };
  }

  const cycleSummary = { ...state.cycleSummary };

  for (const recipient of recipients) {
    cycleSummary.attemptedCount += 1;
    const amountRaw = recipient.amountRaw;
    const amount = ethers.formatUnits(amountRaw, decimals);

    if (amountRaw <= 0n) {
      cycleSummary.skippedCount += 1;
      distributionLedger = appendRecord(distributionLedger, {
        generatedAt: new Date().toISOString(),
        manifestFingerprint,
        recipientAddress: recipient.address,
        amount,
        amountRaw: amountRaw.toString(),
        disposition: "skipped",
        reason: "Rounded distribution amount is zero.",
        txHash: null,
      });
      continue;
    }

    if (execution.dryRun) {
      cycleSummary.dryRunCount += 1;
      distributionLedger = appendRecord(distributionLedger, {
        generatedAt: new Date().toISOString(),
        manifestFingerprint,
        recipientAddress: recipient.address,
        amount,
        amountRaw: amountRaw.toString(),
        disposition: "dry_run",
        reason: "Dry-run is enabled, so no transfer was sent.",
        txHash: null,
      });
      continue;
    }

    try {
      const tx = await contract.transfer(recipient.address, amountRaw);
      const receipt = await tx.wait();
      cycleSummary.executedCount += 1;
      distributionLedger = appendRecord(distributionLedger, {
        generatedAt: new Date().toISOString(),
        manifestFingerprint,
        recipientAddress: recipient.address,
        amount,
        amountRaw: amountRaw.toString(),
        disposition: "executed",
        reason: "Airdrop transfer executed on-chain.",
        txHash: receipt?.hash ?? tx.hash ?? null,
      });
    } catch (error) {
      cycleSummary.failedCount += 1;
      distributionLedger = appendRecord(distributionLedger, {
        generatedAt: new Date().toISOString(),
        manifestFingerprint,
        recipientAddress: recipient.address,
        amount,
        amountRaw: amountRaw.toString(),
        disposition: "failed",
        reason: error instanceof Error ? error.message : String(error),
        txHash: null,
      });
    }
  }

  cycleSummary.note = execution.dryRun
    ? "Distribution execution produced dry-run recipient transfers."
    : cycleSummary.failedCount > 0
      ? "Distribution execution attempted live transfers and at least one failed."
      : cycleSummary.executedCount > 0
        ? "Distribution execution sent live transfers."
        : "Distribution execution found no transfers to send.";

  await saveLedger(reportsDir, distributionLedger);

  return {
    distributionExecution: {
      ...state,
      cycleSummary,
    },
    distributionLedger,
  };
}
