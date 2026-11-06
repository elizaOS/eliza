/**
 * Wallet consent dialog formatters.
 *
 * Read-only helpers used by `BrowserWorkspaceView`'s wallet host bridge
 * to build the consent modal body. Inputs come straight from the dApp via
 * EIP-1193 — these helpers just format for display, never interpret or
 * mutate. Pulled out of the React component file so they're unit-testable
 * without standing up a renderer.
 */

import {
  toWellFormedUnicode,
  truncateWellFormed,
} from "@elizaos/core/protocol";

export function formatAddressForDisplay(address: string): string {
  if (!address) return "(unknown)";
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

const ONE_ETH_WEI = 1_000_000_000_000_000_000n;

export function formatWeiForDisplay(weiDecimalString: string): string {
  if (!weiDecimalString || weiDecimalString === "0") return "0 ETH";
  let wei: bigint;
  try {
    wei = BigInt(weiDecimalString);
  } catch {
    return `${weiDecimalString} wei`;
  }
  const whole = wei / ONE_ETH_WEI;
  const remainder = wei % ONE_ETH_WEI;
  if (remainder === 0n) return `${whole.toString()} ETH`;
  // Consent must show the exact amount, including a single wei.
  const fractionalStr = remainder
    .toString()
    .padStart(18, "0")
    .replace(/0+$/, "");
  return `${whole.toString()}.${fractionalStr || "0"} ETH`;
}

/**
 * EIP-191 / personal_sign callers pass either a UTF-8 string or a
 * 0x-prefixed hex string of the bytes to sign. Show the decoded UTF-8
 * when possible so the user sees the actual prompt rather than hex.
 */
export function decodeSignableMessage(message: string): string {
  // personal_sign hex is case-insensitive. "0X4869" is the same payload
  // as "0x4869"; a lowercase-only prefix leaves the consent dialog showing hex.
  const trimmed = message.trim();
  if (!/^0x/i.test(trimmed) || trimmed.length < 4) return message;
  const hex = trimmed.slice(2);
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return message;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return message;
  }
}

export function decodeBase64ForPreview(base64: string): string {
  try {
    const bin = atob(base64);
    return decodeSignableMessage(
      `0x${[...bin].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("")}`,
    );
  } catch {
    return "(unable to decode message)";
  }
}

export function truncateMessageForDisplay(message: string, max = 240): string {
  const wellFormed = toWellFormedUnicode(message);
  if (max <= 0) return "";
  if (wellFormed.length <= max) return wellFormed;
  if (max === 1) return "…";
  return `${truncateWellFormed(wellFormed, Math.max(0, max))}… (${wellFormed.length - max} more chars)`;
}

const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT64 = (1n << 64n) - 1n;

function hexWord(data: string, index: number): string | null {
  const word = data.slice(8 + index * 64, 8 + (index + 1) * 64);
  return word.length === 64 ? word : null;
}

function wordAddress(word: string | null): string | null {
  return word ? `0x${word.slice(24)}` : null;
}

function wordAmount(word: string | null): string | null {
  if (!word) return null;
  const value = BigInt(`0x${word}`);
  return value === MAX_UINT256
    ? "Unlimited"
    : `${value.toString()} (token base units)`;
}

/**
 * What a contract call does, for the transaction consent dialog. Decodes the
 * common token calls; any other call data gets an explicit warning with its
 * selector, because the page could otherwise move tokens behind "Value: 0".
 */
export function describeEvmCallData(data: unknown): string[] {
  if (typeof data !== "string") return [];
  const hex = data.trim().replace(/^0x/i, "").toLowerCase();
  if (hex.length === 0) return [];
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex) || hex.length < 8) {
    return [
      "Contract call data that cannot be read. Only allow it if you trust this site.",
    ];
  }
  const selector = hex.slice(0, 8);
  const words = (count: number) =>
    Array.from({ length: count }, (_, index) => hexWord(hex, index));
  switch (selector) {
    case "a9059cbb": {
      const [to, amount] = words(2);
      if (wordAddress(to) && wordAmount(amount))
        return [
          "Token transfer from this contract",
          `Recipient: ${wordAddress(to)}`,
          `Amount: ${wordAmount(amount)}`,
        ];
      break;
    }
    case "23b872dd": {
      const [from, to, amount] = words(3);
      if (wordAddress(from) && wordAddress(to) && wordAmount(amount))
        return [
          "Token transfer from another address",
          `From: ${wordAddress(from)}`,
          `Recipient: ${wordAddress(to)}`,
          `Amount: ${wordAmount(amount)}`,
        ];
      break;
    }
    case "095ea7b3":
    case "39509351": {
      const [spender, amount] = words(2);
      if (wordAddress(spender) && wordAmount(amount))
        return [
          selector === "095ea7b3"
            ? "Token approval: lets another address spend your tokens"
            : "Token allowance increase: lets another address spend more of your tokens",
          `Spender: ${wordAddress(spender)}`,
          `Amount: ${wordAmount(amount)}`,
        ];
      break;
    }
    case "a22cb465": {
      const [operator, approved] = words(2);
      if (wordAddress(operator) && approved)
        return BigInt(`0x${approved}`) === 0n
          ? [
              "Removes approval for all tokens of this contract",
              `Operator: ${wordAddress(operator)}`,
            ]
          : [
              "Approval for ALL your tokens of this contract",
              `Operator: ${wordAddress(operator)}`,
            ];
      break;
    }
  }
  return [
    `Contract call 0x${selector} with ${hex.length / 2} bytes of data.`,
    "Eliza cannot show what this call does. Only allow it if you trust this site.",
  ];
}

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);

function readU64(bytes: Uint8Array, offset: number): bigint | null {
  if (bytes.length < offset + 8) return null;
  let value = 0n;
  for (let i = 7; i >= 0; i -= 1)
    value = (value << 8n) | BigInt(bytes[offset + i] ?? 0);
  return value;
}

function lamportsAsSol(lamports: bigint): string {
  const whole = lamports / 1_000_000_000n;
  const fraction = (lamports % 1_000_000_000n)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction} SOL` : `${whole} SOL`;
}

/**
 * What a Solana transaction does, for the consent dialog: SOL and token
 * transfers and token approvals are listed; anything else is named with a
 * warning that its effect cannot be shown.
 */
export async function describeSolanaTransaction(
  transactionBase64: string,
): Promise<string[]> {
  const { VersionedTransaction } = await import("@solana/web3.js");
  let message: InstanceType<typeof VersionedTransaction>["message"];
  try {
    const bin = atob(transactionBase64);
    message = VersionedTransaction.deserialize(
      Uint8Array.from(bin, (char) => char.charCodeAt(0)),
    ).message;
  } catch {
    return [
      "Eliza cannot read this transaction. Only allow it if you trust this site.",
    ];
  }
  const keys = message.staticAccountKeys.map((key) => key.toBase58());
  const lines: string[] = [];
  let opaque = message.addressTableLookups.length > 0;
  for (const instruction of message.compiledInstructions) {
    const program = keys[instruction.programIdIndex];
    const data = instruction.data;
    const account = (index: number) => {
      const key = keys[instruction.accountKeyIndexes[index] ?? -1];
      if (!key) opaque = true;
      return key ?? "(account from a lookup table)";
    };
    if (
      program === SYSTEM_PROGRAM &&
      data.length >= 12 &&
      data[0] === 2 &&
      data[1] === 0 &&
      data[2] === 0 &&
      data[3] === 0
    ) {
      const lamports = readU64(data, 4);
      if (lamports !== null) {
        lines.push(`Send ${lamportsAsSol(lamports)} to ${account(1)}`);
        continue;
      }
    }
    if (program && TOKEN_PROGRAMS.has(program)) {
      const amount = readU64(data, 1);
      if (data[0] === 3 && amount !== null) {
        lines.push(
          `Token transfer: ${amount} base units to token account ${account(1)}`,
        );
        continue;
      }
      if (data[0] === 12 && amount !== null) {
        lines.push(
          `Token transfer: ${amount} base units of mint ${account(1)} to token account ${account(2)}`,
        );
        continue;
      }
      if ((data[0] === 4 || data[0] === 13) && amount !== null) {
        lines.push(
          `Token approval: ${amount === MAX_UINT64 ? "Unlimited" : `${amount} base units`} to delegate ${account(data[0] === 4 ? 1 : 2)}`,
        );
        continue;
      }
    }
    if (program === "ComputeBudget111111111111111111111111111111") continue;
    opaque = true;
    lines.push(`Call to program ${program ?? "(unknown)"}`);
  }
  if (opaque)
    lines.push(
      "Eliza cannot show everything this transaction does. Only allow it if you trust this site.",
    );
  return lines;
}
