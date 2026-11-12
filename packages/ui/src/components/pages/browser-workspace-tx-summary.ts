/**
 * What a dApp transaction does, for the browser wallet consent dialog.
 *
 * A token approval or transfer is a contract call with value 0, so the
 * dialog must show the call itself: the full recipient, the decoded
 * function for the common token calls, and a blind-signing warning for
 * anything this cannot decode.
 */

import { decodeFunctionData, getAddress, maxUint256, parseAbi } from "viem";

export type BrowserWorkspaceTxSummary = {
  lines: string[];
  warning: string | null;
};

const BLIND_SIGNING_WARNING =
  "Eliza cannot read what this does. Only allow it if you trust this site: it may move your tokens.";

const TOKEN_CALLS_ABI = parseAbi([
  "function approve(address spender, uint256 amount)",
  "function increaseAllowance(address spender, uint256 addedValue)",
  "function setApprovalForAll(address operator, bool approved)",
  "function transfer(address to, uint256 amount)",
  "function transferFrom(address from, address to, uint256 amount)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
]);

const RAW_DATA_PREVIEW_CHARS = 202;

function displayAddress(value: unknown): string {
  if (typeof value !== "string" || !value) return "(none)";
  try {
    return getAddress(value);
  } catch {
    return `${value} (not a valid address)`;
  }
}

function displayAmount(value: bigint): string {
  return value === maxUint256
    ? "unlimited"
    : `${value.toString()} (base units)`;
}

function rawDataLine(data: string): string {
  const bytes = Math.floor((data.length - 2) / 2);
  return data.length > RAW_DATA_PREVIEW_CHARS
    ? `Data: ${data.slice(0, RAW_DATA_PREVIEW_CHARS)}… (${bytes} bytes)`
    : `Data: ${data}`;
}

export function summarizeEvmTransaction(tx: {
  to?: unknown;
  data?: unknown;
}): BrowserWorkspaceTxSummary {
  const data =
    typeof tx.data === "string" && tx.data.trim() !== ""
      ? tx.data.trim()
      : "0x";
  const hasTo = typeof tx.to === "string" && tx.to !== "";
  const lines = [`To: ${hasTo ? displayAddress(tx.to) : "(new contract)"}`];
  if (data.toLowerCase() === "0x") {
    return { lines, warning: null };
  }
  if (!hasTo) {
    lines.push("Contract deployment", rawDataLine(data));
    return { lines, warning: BLIND_SIGNING_WARNING };
  }
  const selector = data.slice(0, 10).toLowerCase();
  let decoded: ReturnType<typeof decodeFunctionData<typeof TOKEN_CALLS_ABI>>;
  try {
    decoded = decodeFunctionData({
      abi: TOKEN_CALLS_ABI,
      data: data as `0x${string}`,
    });
  } catch {
    lines.push(
      `Contract call: unknown function (${selector})`,
      rawDataLine(data),
    );
    return { lines, warning: BLIND_SIGNING_WARNING };
  }
  lines.push(`Contract call: ${decoded.functionName} (${selector})`);
  switch (decoded.functionName) {
    case "approve":
    case "increaseAllowance": {
      const [spender, amount] = decoded.args;
      lines.push(`Spender: ${displayAddress(spender)}`);
      lines.push(`Amount: ${displayAmount(amount)}`);
      return {
        lines,
        warning:
          amount === maxUint256
            ? "This lets the spender move all of this token from your wallet."
            : "This lets the spender move this token from your wallet.",
      };
    }
    case "setApprovalForAll": {
      const [operator, approved] = decoded.args;
      lines.push(`Operator: ${displayAddress(operator)}`);
      lines.push(`Approved: ${approved ? "yes, all items" : "no (revoke)"}`);
      return {
        lines,
        warning: approved
          ? "This lets the operator move every item in this collection from your wallet."
          : null,
      };
    }
    case "transfer": {
      const [to, amount] = decoded.args;
      lines.push(`Recipient: ${displayAddress(to)}`);
      lines.push(`Amount: ${displayAmount(amount)}`);
      return { lines, warning: null };
    }
    case "transferFrom": {
      const [from, to, amount] = decoded.args;
      lines.push(`From account: ${displayAddress(from)}`);
      lines.push(`Recipient: ${displayAddress(to)}`);
      lines.push(`Amount: ${displayAmount(amount)}`);
      return { lines, warning: null };
    }
    case "permit": {
      const [owner, spender, value, deadline] = decoded.args;
      lines.push(`Owner: ${displayAddress(owner)}`);
      lines.push(`Spender: ${displayAddress(spender)}`);
      lines.push(`Amount: ${displayAmount(value)}`);
      lines.push(`Deadline: ${deadline.toString()}`);
      return {
        lines,
        warning: "This lets the spender move this token from your wallet.",
      };
    }
  }
}

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
const SYSTEM_TRANSFER_INSTRUCTION = 2;

function readU32LE(bytes: Uint8Array, offset: number): number {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(offset, true);
}

function readU64LE(bytes: Uint8Array, offset: number): bigint {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getBigUint64(offset, true);
}

function formatLamports(lamports: bigint): string {
  const whole = lamports / 1_000_000_000n;
  const fraction = (lamports % 1_000_000_000n)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/, "");
  return `${whole.toString()}${fraction ? `.${fraction}` : ""} SOL`;
}

/**
 * Decode the instructions of a serialized Solana transaction. Plain SOL
 * transfers and compute-budget settings are shown; any other program is
 * listed by id with the blind-signing warning.
 */
export async function summarizeSolanaTransaction(
  transactionBase64: string,
): Promise<BrowserWorkspaceTxSummary> {
  let message: {
    staticAccountKeys: Array<{ toBase58(): string }>;
    compiledInstructions: Array<{
      programIdIndex: number;
      accountKeyIndexes: number[];
      data: Uint8Array;
    }>;
  };
  try {
    // Lazy: @solana/web3.js is large and only needed when a dApp asks.
    const { VersionedTransaction } = await import("@solana/web3.js");
    const bytes = Uint8Array.from(atob(transactionBase64), (c) =>
      c.charCodeAt(0),
    );
    message = VersionedTransaction.deserialize(bytes).message;
  } catch {
    return {
      lines: ["Could not decode this transaction."],
      warning: BLIND_SIGNING_WARNING,
    };
  }
  const lines: string[] = [];
  let undecoded = false;
  const keyAt = (index: number | undefined): string | null =>
    index === undefined
      ? null
      : (message.staticAccountKeys[index]?.toBase58() ?? null);
  for (const ix of message.compiledInstructions) {
    const programId = keyAt(ix.programIdIndex) ?? "(lookup table account)";
    if (
      programId === SYSTEM_PROGRAM_ID &&
      ix.data.length >= 12 &&
      readU32LE(ix.data, 0) === SYSTEM_TRANSFER_INSTRUCTION
    ) {
      const recipient = keyAt(ix.accountKeyIndexes[1]);
      lines.push(
        `Transfer ${formatLamports(readU64LE(ix.data, 4))} to ${recipient ?? "(lookup table account)"}`,
      );
      continue;
    }
    if (programId === COMPUTE_BUDGET_PROGRAM_ID) {
      lines.push("Set compute budget");
      continue;
    }
    undecoded = true;
    lines.push(`Call program ${programId}`);
  }
  if (lines.length === 0) lines.push("No instructions");
  return { lines, warning: undecoded ? BLIND_SIGNING_WARNING : null };
}
