import {
  type Message,
  type MessageCompiledInstruction,
  PublicKey,
  type VersionedMessage,
  VersionedTransaction,
} from "@solana/web3.js";

/**
 * Solana instruction-level transaction parser.
 *
 * SECURITY MODEL
 * --------------
 * The vault signs serialized Solana transactions on behalf of an agent. A naive
 * implementation trusts the caller to describe what the transaction does (e.g. by
 * passing `to`/`value`). That is spoofable: a malicious caller can pass benign
 * policy fields while the serialized bytes do something else entirely.
 *
 * This module derives policy-relevant fields *exclusively from the serialized
 * transaction bytes*. Nothing here ever reads caller-supplied policy hints. The
 * caller compares its (advisory) hints against these authoritative values and
 * rejects on conflict.
 *
 * FAIL-CLOSED CONTRACT
 * --------------------
 * Every instruction in the message is examined. If we cannot *confidently* decode
 * an instruction — unknown program id, unrecognised discriminator, truncated data,
 * out-of-range account index — the instruction is returned with `unparsed: true`
 * and a reason. The same fail-closed marker is applied to decoded instructions
 * whose side effects are not yet represented in the policy envelope (for example
 * SPL approvals/delegates, mint/burn, close-account, or System account creation).
 * The summary's `fullyParsed` flag is false whenever ANY instruction is unparsed
 * or unsupported for policy. Callers MUST refuse to sign a not-fully-parsed
 * transaction unless an explicit, audited blind-signing opt-in is set. Unknown
 * program ids are NEVER treated as safe.
 *
 * The instruction byte layouts decoded here (System Program, SPL Token / Token-2022)
 * are part of those programs' stable on-chain ABIs and are decoded directly from
 * bytes rather than via a heavyweight dependency. This keeps the trusted parsing
 * surface small and auditable.
 */

// ─── Known program ids ───────────────────────────────────────────────────────

/** System Program. */
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
/** SPL Token program (Tokenkeg…). */
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
/** SPL Token-2022 program (TokenzQd…). Shares the classic Token instruction layout. */
export const TOKEN_2022_PROGRAM_ID =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
/** Associated Token Account program. */
export const ASSOCIATED_TOKEN_PROGRAM_ID =
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
/** Compute Budget program (no value movement; safe to recognise but carries no policy fields). */
export const COMPUTE_BUDGET_PROGRAM_ID =
  "ComputeBudget111111111111111111111111111111";
/** Memo program v2 (no value movement). */
export const MEMO_PROGRAM_ID = "MemoSq4gq4ko9d4Cu9d4mGmFEKQ8L7sBoP7HfHGv5";

const SPL_TOKEN_PROGRAM_IDS = new Set<string>([
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
]);
const COMPUTE_BUDGET_MAX_UNIT_LIMIT = 1_400_000;
const COMPUTE_BUDGET_MAX_PRIORITY_FEE_LAMPORTS = 500_000n;

// ─── Result types ────────────────────────────────────────────────────────────

export type SolanaInstructionType =
  // System Program
  | "system:Transfer"
  | "system:TransferWithSeed"
  | "system:CreateAccount"
  | "system:CreateAccountWithSeed"
  | "system:Assign"
  | "system:Allocate"
  // SPL Token
  | "spl-token:Transfer"
  | "spl-token:TransferChecked"
  | "spl-token:Approve"
  | "spl-token:ApproveChecked"
  | "spl-token:Burn"
  | "spl-token:BurnChecked"
  | "spl-token:MintTo"
  | "spl-token:MintToChecked"
  | "spl-token:CloseAccount"
  | "spl-token:InitializeAccount3"
  // Recognised but value-neutral
  | "compute-budget:SetComputeUnitLimit"
  | "compute-budget:SetComputeUnitPrice"
  | "compute-budget"
  | "memo"
  | "associated-token-account:Create";

/**
 * A single decoded instruction. `fields` is a flat, JSON-serialisable bag of the
 * policy-relevant values derived from the bytes. bigints are stringified.
 */
export interface ParsedInstruction {
  programId: string;
  /** Index of this instruction within the message (top-level order). */
  index: number;
  instructionType?: SolanaInstructionType;
  /** True when we could NOT confidently decode this instruction. Fail closed. */
  unparsed: boolean;
  /** Human-readable reason populated when `unparsed` is true. */
  reason?: string;
  fields: Record<string, string | number | boolean | undefined>;
}

export interface TokenTransferSummary {
  /** Source token account. */
  source: string;
  /** Destination token account. */
  destination: string;
  /** Owner/authority that signed the transfer (if derivable). */
  authority?: string;
  /** Mint, only present for *Checked variants where the mint is in the accounts. */
  mint?: string;
  /** Raw token amount (base units), decimal string. */
  amount: string;
  /** Decimals, only present for *Checked variants. */
  decimals?: number;
  /** The token program that owns this instruction. */
  programId: string;
}

export interface ParsedTransactionSummary {
  /** True when EVERY instruction decoded confidently. Callers must require this. */
  fullyParsed: boolean;
  /** Message version: "legacy" or 0. */
  version: "legacy" | number;
  /** Fee payer (first writable signer account). */
  feePayer?: string;
  /** All instructions in order. */
  instructions: ParsedInstruction[];
  /**
   * Net native SOL movement out of accounts, expressed as the total lamports sent
   * by System transfers. Used as the authoritative `value` for SOL policy.
   */
  totalLamports: string;
  /**
   * Distinct native-SOL recipients (System transfer destinations), in first-seen
   * order. The first entry is treated as the primary recipient for policy.
   */
  lamportRecipients: string[];
  /** All SPL token transfers (Transfer + TransferChecked). */
  tokenTransfers: TokenTransferSummary[];
  /** Reasons for any unparsed instructions (for diagnostics / audit). */
  unparsedReasons: string[];
}

// ─── Deserialisation ─────────────────────────────────────────────────────────

function decodeTransactionBytes(serialized: string): Uint8Array {
  const trimmed = serialized.trim();
  if (trimmed.length === 0) {
    throw new Error("empty transaction payload");
  }

  // Try base64 first (the canonical wire format used elsewhere in the vault),
  // then fall back to base58 (Phantom / some RPC responses).
  const base64Candidate = tryDecodeBase64(trimmed);
  if (base64Candidate) return base64Candidate;

  const base58Candidate = tryDecodeBase58(trimmed);
  if (base58Candidate) return base58Candidate;

  throw new Error("transaction is not valid base64 or base58");
}

function tryDecodeBase64(value: string): Uint8Array | null {
  // Charset gate first. Use atob/btoa (not Buffer) because @solana/web3.js bundles
  // a browser Buffer shim into this package whose typings reject the "base64"
  // encoding — the rest of the vault uses atob/btoa for the same reason.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  try {
    const binary = atob(value);
    if (binary.length === 0) return null;
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    // Round-trip guard: atob is lenient; re-encode and compare (ignoring padding).
    const reencoded = btoa(binary).replace(/=+$/, "");
    if (reencoded !== value.replace(/=+$/, "")) return null;
    return out;
  } catch {
    return null;
  }
}

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function tryDecodeBase58(value: string): Uint8Array | null {
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) return null;
  try {
    const BASE = 58n;
    let leadingZeros = 0;
    for (let i = 0; i < value.length && value[i] === "1"; i++) leadingZeros++;
    let num = 0n;
    for (const char of value) {
      const idx = BASE58_ALPHABET.indexOf(char);
      if (idx === -1) return null;
      num = num * BASE + BigInt(idx);
    }
    const bytes: number[] = [];
    while (num > 0n) {
      bytes.unshift(Number(num % 256n));
      num = num / 256n;
    }
    const out = new Uint8Array(leadingZeros + bytes.length);
    out.set(bytes, leadingZeros);
    return out.length === 0 ? null : out;
  } catch {
    return null;
  }
}

/**
 * Deserialize a serialized Solana transaction (signed or unsigned) into its
 * VersionedMessage. Handles BOTH legacy and v0 wire formats.
 *
 * VersionedTransaction.deserialize understands both legacy and versioned wire
 * encodings: legacy messages have their version byte absent (top bit of the
 * first byte clear), v0 messages set the 0x80 prefix. We let web3.js do the
 * disambiguation, which is the same logic the on-chain runtime uses.
 */
export function deserializeSolanaMessage(serialized: string): {
  message: VersionedMessage;
  version: "legacy" | number;
} {
  const bytes = decodeTransactionBytes(serialized);
  const vtx = VersionedTransaction.deserialize(bytes);
  const message = vtx.message;
  return { message, version: message.version };
}

// ─── Account / instruction normalisation ─────────────────────────────────────

interface NormalizedInstruction {
  programIdIndex: number;
  accountKeyIndexes: number[];
  data: Uint8Array;
}

/**
 * Both legacy `Message` and `MessageV0` expose a `compiledInstructions` getter
 * with a uniform shape ({ programIdIndex, accountKeyIndexes, data: Uint8Array }).
 * The legacy getter base58-decodes its instruction data internally, so this is
 * the single normalised path for both wire formats. Note: only static account
 * keys can be resolved from the message — address-lookup-table accounts live
 * off-message, so any instruction referencing them is treated as undecodable
 * (fail closed) below.
 */
function normalizeInstructions(
  message: VersionedMessage,
): NormalizedInstruction[] {
  const compiled = (
    message as { compiledInstructions?: MessageCompiledInstruction[] }
  ).compiledInstructions;
  if (!Array.isArray(compiled)) {
    // Defensive: a message shape without compiledInstructions is unexpected.
    // Returning empty makes summarize() report fullyParsed with no effects,
    // but deserializeSolanaMessage only yields web3.js Message/MessageV0, both
    // of which implement the getter, so this branch is effectively unreachable.
    return [];
  }
  return compiled.map((ix) => ({
    programIdIndex: ix.programIdIndex,
    accountKeyIndexes: Array.from(ix.accountKeyIndexes),
    data: Uint8Array.from(ix.data),
  }));
}

/**
 * Resolve the full static account key list. For legacy messages this is
 * `accountKeys`; for v0 it's `staticAccountKeys`. Lookup-table-loaded keys are
 * intentionally NOT resolved here (they live off-message), so any instruction
 * whose account index points past the static list is flagged unparsed.
 */
function getStaticAccountKeys(message: VersionedMessage): PublicKey[] {
  const staticKeys = (message as { staticAccountKeys?: PublicKey[] })
    .staticAccountKeys;
  if (Array.isArray(staticKeys)) return staticKeys;
  const legacyKeys = (message as unknown as Message).accountKeys;
  return legacyKeys ?? [];
}

function numLookupAccounts(message: VersionedMessage): number {
  const lookups = (
    message as {
      addressTableLookups?: {
        writableIndexes: number[];
        readonlyIndexes: number[];
      }[];
    }
  ).addressTableLookups;
  if (!Array.isArray(lookups)) return 0;
  return lookups.reduce(
    (acc, l) =>
      acc + (l.writableIndexes?.length ?? 0) + (l.readonlyIndexes?.length ?? 0),
    0,
  );
}

const POLICY_SUPPORTED_INSTRUCTION_TYPES = new Set<SolanaInstructionType>([
  "system:Transfer",
  "system:CreateAccount",
  "spl-token:Transfer",
  "spl-token:TransferChecked",
  "compute-budget:SetComputeUnitLimit",
  "compute-budget:SetComputeUnitPrice",
  "compute-budget",
  "memo",
]);

function failClosedPolicyReason(
  instructionType: SolanaInstructionType | undefined,
): string | null {
  if (
    !instructionType ||
    POLICY_SUPPORTED_INSTRUCTION_TYPES.has(instructionType)
  )
    return null;
  return `${instructionType} is decoded but not supported by the Solana policy envelope; refusing to sign without blind-signing opt-in`;
}

function markUnsupportedPolicyInstruction(
  ix: ParsedInstruction,
): ParsedInstruction {
  if (ix.unparsed) return ix;
  const reason = failClosedPolicyReason(ix.instructionType);
  return reason ? { ...ix, unparsed: true, reason } : ix;
}

// ─── Little-endian byte readers ──────────────────────────────────────────────

function readU32LE(data: Uint8Array, offset: number): number {
  return (
    (data[offset] |
      (data[offset + 1] << 8) |
      (data[offset + 2] << 16) |
      (data[offset + 3] << 24)) >>>
    0
  );
}

function readU64LE(data: Uint8Array, offset: number): bigint {
  let result = 0n;
  for (let i = 0; i < 8; i++) {
    result |= BigInt(data[offset + i]) << BigInt(8 * i);
  }
  return result;
}

const COMPUTE_BUDGET_IX = {
  RequestUnitsDeprecated: 0,
  RequestHeapFrame: 1,
  SetComputeUnitLimit: 2,
  SetComputeUnitPrice: 3,
  SetLoadedAccountsDataSizeLimit: 4,
} as const;

function decodeComputeBudgetInstruction(
  index: number,
  data: Uint8Array,
): ParsedInstruction {
  const base = (extra: Partial<ParsedInstruction>): ParsedInstruction => ({
    programId: COMPUTE_BUDGET_PROGRAM_ID,
    index,
    unparsed: false,
    fields: {},
    ...extra,
  });
  const unparsed = (reason: string): ParsedInstruction =>
    base({ unparsed: true, reason, fields: {} });

  if (data.length < 1)
    return unparsed("compute budget instruction data too short");
  const disc = data[0];

  switch (disc) {
    case COMPUTE_BUDGET_IX.SetComputeUnitLimit: {
      if (data.length < 5)
        return unparsed("SetComputeUnitLimit data too short");
      return base({
        instructionType: "compute-budget:SetComputeUnitLimit",
        fields: { computeUnitLimit: readU32LE(data, 1) },
      });
    }
    case COMPUTE_BUDGET_IX.SetComputeUnitPrice: {
      if (data.length < 9)
        return unparsed("SetComputeUnitPrice data too short");
      const microLamports = readU64LE(data, 1);
      return base({
        instructionType: "compute-budget:SetComputeUnitPrice",
        fields: { microLamports: microLamports.toString() },
      });
    }
    case COMPUTE_BUDGET_IX.RequestUnitsDeprecated:
    case COMPUTE_BUDGET_IX.RequestHeapFrame:
    case COMPUTE_BUDGET_IX.SetLoadedAccountsDataSizeLimit:
      return unparsed(
        `unsupported Compute Budget instruction discriminator ${disc}; cannot verify fee exposure`,
      );
    default:
      return unparsed(
        `unsupported Compute Budget instruction discriminator ${disc}`,
      );
  }
}

function isParsedComputeBudgetInstruction(
  instruction: ParsedInstruction,
): boolean {
  return (
    instruction.programId === COMPUTE_BUDGET_PROGRAM_ID &&
    instruction.unparsed === false &&
    (instruction.instructionType === "compute-budget:SetComputeUnitLimit" ||
      instruction.instructionType === "compute-budget:SetComputeUnitPrice")
  );
}

function assertParsedComputeBudgetWithinCap(
  instructions: ParsedInstruction[],
): void {
  let explicitUnitLimit: number | undefined;
  let microLamportsPerCu = 0n;

  for (const instruction of instructions) {
    if (instruction.instructionType === "compute-budget:SetComputeUnitLimit") {
      const units = instruction.fields.computeUnitLimit;
      if (typeof units === "number") explicitUnitLimit = units;
    }
    if (instruction.instructionType === "compute-budget:SetComputeUnitPrice") {
      const price = instruction.fields.microLamports;
      if (typeof price === "string") microLamportsPerCu = BigInt(price);
    }
  }

  if (microLamportsPerCu === 0n) return;
  const valueInstructionCount = Math.max(
    1,
    instructions.filter(
      (instruction) => !isParsedComputeBudgetInstruction(instruction),
    ).length,
  );
  const effectiveUnitLimit =
    explicitUnitLimit ??
    Math.min(COMPUTE_BUDGET_MAX_UNIT_LIMIT, 200_000 * valueInstructionCount);
  // Solana charges the priority fee rounded UP to the next lamport, so use
  // ceiling division here. Flooring would let a fee of e.g. 500,001 lamports
  // (product 500,000.x) slip past a 500,000 cap. Fail closed.
  const feeNumerator = BigInt(effectiveUnitLimit) * microLamportsPerCu;
  const projectedLamports = (feeNumerator + 999_999n) / 1_000_000n;
  if (projectedLamports > COMPUTE_BUDGET_MAX_PRIORITY_FEE_LAMPORTS) {
    throw new Error(
      `Solana priority fee (${projectedLamports} lamports) exceeds the allowed maximum of ${COMPUTE_BUDGET_MAX_PRIORITY_FEE_LAMPORTS} lamports`,
    );
  }
}

export function assertSolanaPriorityFeeWithinCap(
  summary: ParsedTransactionSummary,
): void {
  assertParsedComputeBudgetWithinCap(summary.instructions);
}

// ─── System Program decoding ─────────────────────────────────────────────────
// Instruction type is a u32 LE discriminator at offset 0.
const SYSTEM_IX = {
  CreateAccount: 0,
  Assign: 1,
  Transfer: 2,
  CreateAccountWithSeed: 3,
  Allocate: 8,
  TransferWithSeed: 11,
} as const;

function decodeSystemInstruction(
  index: number,
  data: Uint8Array,
  accounts: PublicKey[],
): ParsedInstruction {
  const base = (extra: Partial<ParsedInstruction>): ParsedInstruction => ({
    programId: SYSTEM_PROGRAM_ID,
    index,
    unparsed: false,
    fields: {},
    ...extra,
  });
  const unparsed = (reason: string): ParsedInstruction =>
    base({ unparsed: true, reason, fields: {} });

  if (data.length < 4)
    return unparsed("system instruction data too short for discriminator");
  const disc = readU32LE(data, 0);

  switch (disc) {
    case SYSTEM_IX.Transfer: {
      // u32 discriminator + u64 lamports = 12 bytes. accounts: [from, to]
      if (data.length < 12) return unparsed("system Transfer data too short");
      if (accounts.length < 2)
        return unparsed("system Transfer missing from/to accounts");
      const lamports = readU64LE(data, 4);
      return base({
        instructionType: "system:Transfer",
        fields: {
          from: accounts[0].toBase58(),
          to: accounts[1].toBase58(),
          lamports: lamports.toString(),
        },
      });
    }
    case SYSTEM_IX.TransferWithSeed: {
      // u32 disc + u64 lamports + (u64 seedLen + seed bytes) + pubkey owner.
      // accounts: [from(base), fromBaseAuthority(signer), to]
      if (data.length < 12)
        return unparsed("system TransferWithSeed data too short");
      if (accounts.length < 3)
        return unparsed("system TransferWithSeed missing accounts");
      const lamports = readU64LE(data, 4);
      return base({
        instructionType: "system:TransferWithSeed",
        fields: {
          from: accounts[0].toBase58(),
          to: accounts[2].toBase58(),
          lamports: lamports.toString(),
        },
      });
    }
    case SYSTEM_IX.CreateAccount: {
      // disc + u64 lamports + u64 space + pubkey owner. accounts: [from, new]
      if (data.length < 52)
        return unparsed("system CreateAccount data too short");
      if (accounts.length < 2)
        return unparsed("system CreateAccount missing accounts");
      const lamports = readU64LE(data, 4);
      return base({
        instructionType: "system:CreateAccount",
        fields: {
          from: accounts[0].toBase58(),
          newAccount: accounts[1].toBase58(),
          lamports: lamports.toString(),
        },
      });
    }
    case SYSTEM_IX.CreateAccountWithSeed: {
      // The funding lamports sit after a variable-length seed (disc + base pubkey
      // + u64 seed-len + seed bytes), so the amount is at an offset we cannot
      // decode safely. A "fully parsed" CreateAccountWithSeed would move SOL the
      // policy never accounts for — fail closed so it requires an audited
      // blind-sign opt-in rather than silently passing with value=0.
      return unparsed(
        "system CreateAccountWithSeed funds an account by a non-decodable (variable-offset) lamport amount",
      );
    }
    case SYSTEM_IX.Assign: {
      if (accounts.length < 1) return unparsed("system Assign missing account");
      return base({
        instructionType: "system:Assign",
        fields: { account: accounts[0].toBase58() },
      });
    }
    case SYSTEM_IX.Allocate: {
      if (accounts.length < 1)
        return unparsed("system Allocate missing account");
      return base({
        instructionType: "system:Allocate",
        fields: { account: accounts[0].toBase58() },
      });
    }
    default:
      return unparsed(
        `unsupported System Program instruction discriminator ${disc}`,
      );
  }
}

// ─── SPL Token decoding ──────────────────────────────────────────────────────
// Instruction type is a single u8 discriminator at offset 0.
const TOKEN_IX = {
  InitializeAccount: 1,
  Transfer: 3,
  Approve: 4,
  Revoke: 5,
  MintTo: 7,
  Burn: 8,
  CloseAccount: 9,
  TransferChecked: 12,
  ApproveChecked: 13,
  MintToChecked: 14,
  BurnChecked: 15,
  InitializeAccount3: 18,
} as const;

function decodeTokenInstruction(
  programId: string,
  index: number,
  data: Uint8Array,
  accounts: PublicKey[],
): ParsedInstruction {
  const base = (extra: Partial<ParsedInstruction>): ParsedInstruction => ({
    programId,
    index,
    unparsed: false,
    fields: {},
    ...extra,
  });
  const unparsed = (reason: string): ParsedInstruction =>
    base({ unparsed: true, reason, fields: {} });

  if (data.length < 1) return unparsed("token instruction data empty");
  const disc = data[0];

  switch (disc) {
    case TOKEN_IX.Transfer: {
      // u8 disc + u64 amount. accounts: [source, destination, authority, ...signers]
      if (data.length < 9) return unparsed("token Transfer data too short");
      if (accounts.length < 3)
        return unparsed("token Transfer missing accounts");
      const amount = readU64LE(data, 1);
      return base({
        instructionType: "spl-token:Transfer",
        fields: {
          source: accounts[0].toBase58(),
          destination: accounts[1].toBase58(),
          authority: accounts[2].toBase58(),
          amount: amount.toString(),
        },
      });
    }
    case TOKEN_IX.TransferChecked: {
      // u8 disc + u64 amount + u8 decimals. accounts: [source, mint, destination, authority, ...]
      if (data.length < 10)
        return unparsed("token TransferChecked data too short");
      if (accounts.length < 4)
        return unparsed("token TransferChecked missing accounts");
      const amount = readU64LE(data, 1);
      const decimals = data[9];
      return base({
        instructionType: "spl-token:TransferChecked",
        fields: {
          source: accounts[0].toBase58(),
          mint: accounts[1].toBase58(),
          destination: accounts[2].toBase58(),
          authority: accounts[3].toBase58(),
          amount: amount.toString(),
          decimals,
        },
      });
    }
    case TOKEN_IX.Approve: {
      // u8 disc + u64 amount. accounts: [source, delegate, owner, ...]
      if (data.length < 9) return unparsed("token Approve data too short");
      if (accounts.length < 3)
        return unparsed("token Approve missing accounts");
      const amount = readU64LE(data, 1);
      return base({
        instructionType: "spl-token:Approve",
        fields: {
          source: accounts[0].toBase58(),
          delegate: accounts[1].toBase58(),
          owner: accounts[2].toBase58(),
          amount: amount.toString(),
        },
      });
    }
    case TOKEN_IX.ApproveChecked: {
      // u8 disc + u64 amount + u8 decimals. accounts: [source, mint, delegate, owner, ...]
      if (data.length < 10)
        return unparsed("token ApproveChecked data too short");
      if (accounts.length < 4)
        return unparsed("token ApproveChecked missing accounts");
      const amount = readU64LE(data, 1);
      const decimals = data[9];
      return base({
        instructionType: "spl-token:ApproveChecked",
        fields: {
          source: accounts[0].toBase58(),
          mint: accounts[1].toBase58(),
          delegate: accounts[2].toBase58(),
          owner: accounts[3].toBase58(),
          amount: amount.toString(),
          decimals,
        },
      });
    }
    case TOKEN_IX.Burn: {
      // u8 disc + u64 amount. accounts: [account, mint, owner, ...]
      if (data.length < 9) return unparsed("token Burn data too short");
      if (accounts.length < 3) return unparsed("token Burn missing accounts");
      const amount = readU64LE(data, 1);
      return base({
        instructionType: "spl-token:Burn",
        fields: {
          account: accounts[0].toBase58(),
          mint: accounts[1].toBase58(),
          owner: accounts[2].toBase58(),
          amount: amount.toString(),
        },
      });
    }
    case TOKEN_IX.BurnChecked: {
      // u8 disc + u64 amount + u8 decimals. accounts: [account, mint, owner, ...]
      if (data.length < 10) return unparsed("token BurnChecked data too short");
      if (accounts.length < 3)
        return unparsed("token BurnChecked missing accounts");
      const amount = readU64LE(data, 1);
      const decimals = data[9];
      return base({
        instructionType: "spl-token:BurnChecked",
        fields: {
          account: accounts[0].toBase58(),
          mint: accounts[1].toBase58(),
          owner: accounts[2].toBase58(),
          amount: amount.toString(),
          decimals,
        },
      });
    }
    case TOKEN_IX.MintTo: {
      // u8 disc + u64 amount. accounts: [mint, destination, mintAuthority, ...]
      if (data.length < 9) return unparsed("token MintTo data too short");
      if (accounts.length < 3) return unparsed("token MintTo missing accounts");
      const amount = readU64LE(data, 1);
      return base({
        instructionType: "spl-token:MintTo",
        fields: {
          mint: accounts[0].toBase58(),
          destination: accounts[1].toBase58(),
          mintAuthority: accounts[2].toBase58(),
          amount: amount.toString(),
        },
      });
    }
    case TOKEN_IX.MintToChecked: {
      // u8 disc + u64 amount + u8 decimals. accounts: [mint, destination, mintAuthority, ...]
      if (data.length < 10)
        return unparsed("token MintToChecked data too short");
      if (accounts.length < 3)
        return unparsed("token MintToChecked missing accounts");
      const amount = readU64LE(data, 1);
      const decimals = data[9];
      return base({
        instructionType: "spl-token:MintToChecked",
        fields: {
          mint: accounts[0].toBase58(),
          destination: accounts[1].toBase58(),
          mintAuthority: accounts[2].toBase58(),
          amount: amount.toString(),
          decimals,
        },
      });
    }
    case TOKEN_IX.CloseAccount: {
      // u8 disc, no payload. accounts: [account, destination, owner, ...]
      if (accounts.length < 3)
        return unparsed("token CloseAccount missing accounts");
      return base({
        instructionType: "spl-token:CloseAccount",
        fields: {
          account: accounts[0].toBase58(),
          destination: accounts[1].toBase58(),
          owner: accounts[2].toBase58(),
        },
      });
    }
    case TOKEN_IX.InitializeAccount3: {
      // u8 disc + pubkey owner (32 bytes). accounts: [account, mint]
      if (data.length < 33)
        return unparsed("token InitializeAccount3 data too short");
      if (accounts.length < 2)
        return unparsed("token InitializeAccount3 missing accounts");
      const owner = new PublicKey(data.slice(1, 33)).toBase58();
      return base({
        instructionType: "spl-token:InitializeAccount3",
        fields: {
          account: accounts[0].toBase58(),
          mint: accounts[1].toBase58(),
          owner,
        },
      });
    }
    default:
      return unparsed(
        `unsupported SPL Token instruction discriminator ${disc}`,
      );
  }
}

// ─── Top-level parse ─────────────────────────────────────────────────────────

/**
 * Parse a serialized Solana transaction into structured, policy-relevant fields
 * derived solely from the bytes. Never throws for *content* reasons — undecodable
 * instructions are reported via `unparsed: true`. Only throws if the payload
 * cannot be deserialized into a transaction at all (which callers must also treat
 * as fail-closed).
 */
export function parseSolanaTransaction(
  serialized: string,
): ParsedTransactionSummary {
  const { message, version } = deserializeSolanaMessage(serialized);
  const accountKeys = getStaticAccountKeys(message);
  const instructions = normalizeInstructions(message);
  const lookupCount = numLookupAccounts(message);

  const parsed: ParsedInstruction[] = instructions.map((ix, index) => {
    // Resolve program id from static keys; lookup-table program ids are not
    // resolvable here, so treat as undecodable.
    if (ix.programIdIndex < 0 || ix.programIdIndex >= accountKeys.length) {
      return {
        programId: "<unknown>",
        index,
        unparsed: true,
        reason:
          lookupCount > 0
            ? "program id resolves through an address lookup table and cannot be verified"
            : "program id index out of range",
        fields: {},
      };
    }
    const programId = accountKeys[ix.programIdIndex].toBase58();

    // Resolve instruction account pubkeys from static keys. If any index points
    // into lookup-table space, we cannot verify it — fail closed.
    const accounts: PublicKey[] = [];
    let outOfRange = false;
    for (const accIdx of ix.accountKeyIndexes) {
      if (accIdx < 0 || accIdx >= accountKeys.length) {
        outOfRange = true;
        break;
      }
      accounts.push(accountKeys[accIdx]);
    }
    if (outOfRange) {
      return {
        programId,
        index,
        unparsed: true,
        reason:
          lookupCount > 0
            ? "instruction references an address-lookup-table account that cannot be verified"
            : "instruction account index out of range",
        fields: {},
      };
    }

    if (programId === SYSTEM_PROGRAM_ID) {
      return decodeSystemInstruction(index, ix.data, accounts);
    }
    if (SPL_TOKEN_PROGRAM_IDS.has(programId)) {
      return decodeTokenInstruction(programId, index, ix.data, accounts);
    }
    if (programId === COMPUTE_BUDGET_PROGRAM_ID) {
      return decodeComputeBudgetInstruction(index, ix.data);
    }
    if (programId === MEMO_PROGRAM_ID) {
      return {
        programId,
        index,
        instructionType: "memo",
        unparsed: false,
        fields: {},
      };
    }

    // Unknown program id → NEVER safe. Fail closed.
    return {
      programId,
      index,
      unparsed: true,
      reason: `unrecognised program id ${programId}; cannot verify instruction effects`,
      fields: {},
    };
  });

  return summarize(
    parsed.map(markUnsupportedPolicyInstruction),
    version,
    accountKeys,
  );
}

function summarize(
  instructions: ParsedInstruction[],
  version: "legacy" | number,
  accountKeys: PublicKey[],
): ParsedTransactionSummary {
  let totalLamports = 0n;
  const lamportRecipients: string[] = [];
  const tokenTransfers: TokenTransferSummary[] = [];
  const unparsedReasons: string[] = [];

  for (const ix of instructions) {
    if (ix.unparsed) {
      unparsedReasons.push(
        ix.reason ?? `unparsed instruction at index ${ix.index}`,
      );
      continue;
    }
    if (
      ix.instructionType === "system:Transfer" ||
      ix.instructionType === "system:TransferWithSeed" ||
      ix.instructionType === "system:CreateAccount"
    ) {
      const lamports = ix.fields.lamports;
      // A Transfer sends to `to`; a CreateAccount funds a NEW account (`newAccount`).
      // Both move native SOL and must be counted toward the spend cap / recipients.
      const to = ix.fields.to ?? ix.fields.newAccount;
      if (typeof lamports === "string") totalLamports += BigInt(lamports);
      if (typeof to === "string" && !lamportRecipients.includes(to)) {
        lamportRecipients.push(to);
      }
    }
    if (
      ix.instructionType === "spl-token:Transfer" ||
      ix.instructionType === "spl-token:TransferChecked"
    ) {
      tokenTransfers.push({
        source: String(ix.fields.source),
        destination: String(ix.fields.destination),
        authority: ix.fields.authority
          ? String(ix.fields.authority)
          : undefined,
        mint: ix.fields.mint ? String(ix.fields.mint) : undefined,
        amount: String(ix.fields.amount ?? "0"),
        decimals:
          typeof ix.fields.decimals === "number"
            ? ix.fields.decimals
            : undefined,
        programId: ix.programId,
      });
    }
  }

  return {
    fullyParsed: instructions.every((ix) => !ix.unparsed),
    version,
    feePayer: accountKeys.length > 0 ? accountKeys[0].toBase58() : undefined,
    instructions,
    totalLamports: totalLamports.toString(),
    lamportRecipients,
    tokenTransfers,
    unparsedReasons,
  };
}

// ─── Policy field derivation ─────────────────────────────────────────────────

export interface DerivedSolanaPolicyFields {
  /**
   * Authoritative primary recipient for policy evaluation:
   * - native SOL transfer → the SOL recipient
   * - otherwise, the first token transfer destination
   * - otherwise undefined (e.g. pure close/burn) — caller decides.
   */
  to?: string;
  /**
   * Authoritative value (uint string):
   * - native SOL transfers → total lamports
   * - token-only transactions → total token base-units of the (single) mint
   */
  value: string;
  /** True when this transaction moves native SOL. */
  movesNativeSol: boolean;
  /** Distinct mints touched by token transfers. */
  mints: string[];
  /** All program ids referenced (for allowed-program style policy). */
  programIds: string[];
  fullyParsed: boolean;
  summary: ParsedTransactionSummary;
}

/**
 * Collapse a parsed transaction into the single (to, value) envelope the policy
 * engine evaluates, plus the auxiliary fields a Solana-aware policy needs.
 *
 * Precedence: native SOL movement defines (to, value). If there is no native SOL
 * movement but there are token transfers, the first token transfer's destination
 * and the summed token amount define the envelope. This keeps spending-limit /
 * approved-address policies meaningful for the dominant economic effect.
 */
export function deriveSolanaPolicyFields(
  summary: ParsedTransactionSummary,
): DerivedSolanaPolicyFields {
  const programIds = Array.from(
    new Set(summary.instructions.map((ix) => ix.programId)),
  );
  const mints = Array.from(
    new Set(
      summary.tokenTransfers
        .map((t) => t.mint)
        .filter((m): m is string => typeof m === "string"),
    ),
  );

  const movesNativeSol =
    summary.lamportRecipients.length > 0 || summary.totalLamports !== "0";

  if (movesNativeSol) {
    return {
      to: summary.lamportRecipients[0],
      value: summary.totalLamports,
      movesNativeSol: true,
      mints,
      programIds,
      fullyParsed: summary.fullyParsed,
      summary,
    };
  }

  if (summary.tokenTransfers.length > 0) {
    const totalTokens = summary.tokenTransfers.reduce(
      (acc, t) => acc + BigInt(t.amount),
      0n,
    );
    return {
      to: summary.tokenTransfers[0].destination,
      value: totalTokens.toString(),
      movesNativeSol: false,
      mints,
      programIds,
      fullyParsed: summary.fullyParsed,
      summary,
    };
  }

  // No value movement detected (e.g. close-account only).
  return {
    to: undefined,
    value: "0",
    movesNativeSol: false,
    mints,
    programIds,
    fullyParsed: summary.fullyParsed,
    summary,
  };
}

/**
 * Compare caller-supplied advisory policy hints against the authoritative parsed
 * values. Returns a list of human-readable conflicts; empty means consistent.
 *
 * Address comparison is case-sensitive base58 by default but tolerates the
 * caller passing the SAME address. We do NOT lowercase Solana base58 (it is
 * case-significant). For `value` we compare as bigints to ignore leading zeros.
 */
export function detectSolanaPolicyConflicts(
  derived: DerivedSolanaPolicyFields,
  caller: { to?: string; value?: string },
): string[] {
  const conflicts: string[] = [];

  if (caller.to !== undefined && caller.to !== "") {
    if (derived.to === undefined) {
      conflicts.push(
        `caller supplied recipient ${caller.to} but the transaction moves no funds to a derivable recipient`,
      );
    } else if (caller.to !== derived.to) {
      conflicts.push(
        `caller-supplied recipient ${caller.to} does not match transaction recipient ${derived.to}`,
      );
    }
  }

  if (caller.value !== undefined && caller.value !== "") {
    let callerValue: bigint | null = null;
    try {
      callerValue = BigInt(caller.value);
    } catch {
      callerValue = null;
    }
    if (callerValue === null) {
      conflicts.push(
        `caller-supplied value ${caller.value} is not a valid integer`,
      );
    } else {
      let derivedValue: bigint;
      try {
        derivedValue = BigInt(derived.value);
      } catch {
        derivedValue = 0n;
      }
      if (callerValue !== derivedValue) {
        conflicts.push(
          `caller-supplied value ${caller.value} does not match transaction value ${derived.value}`,
        );
      }
    }
  }

  return conflicts;
}

/**
 * Version-agnostic transfer-envelope assertion (works for legacy AND v0/versioned
 * transactions, since the parser deserializes both). Throws unless the serialized
 * transaction fully parses and its derived (to, value) match the expected policy
 * envelope. Used by the vault's sign path for v0 transactions, where the legacy
 * byte-level `assertSolanaTransferTransactionMatches` cannot apply.
 */
export function assertParsedSolanaTransferMatches(
  serialized: string,
  expected: { from?: string; to: string; lamports: bigint },
): void {
  if (expected.lamports < 0n) {
    throw new Error("expected Solana transfer lamports must be non-negative");
  }
  const summary = parseSolanaTransaction(serialized);
  if (!summary.fullyParsed) {
    throw new Error(
      "Solana transaction is not fully parseable; cannot verify it against the policy envelope",
    );
  }
  const valueInstructions = summary.instructions.filter(
    (instruction) => !isParsedComputeBudgetInstruction(instruction),
  );
  assertParsedComputeBudgetWithinCap(summary.instructions);
  if (valueInstructions.length !== 1) {
    throw new Error(
      "Solana signing only supports a single policy-checked transfer instruction",
    );
  }

  const [instruction] = valueInstructions;
  if (instruction.instructionType !== "system:Transfer") {
    throw new Error(
      "Solana transaction instruction must be a SystemProgram transfer",
    );
  }
  if (expected.from && instruction.fields.from !== expected.from) {
    throw new Error("Solana transfer source does not match the vault wallet");
  }
  if (instruction.fields.to !== expected.to) {
    throw new Error(
      "Solana transfer recipient does not match the policy envelope",
    );
  }
  if (
    BigInt(String(instruction.fields.lamports ?? "0")) !== expected.lamports
  ) {
    throw new Error(
      "Solana transfer amount does not match the policy envelope",
    );
  }
}

/** Read a shortvec / compact-u16 length prefix. Returns the value + bytes consumed. */
function readCompactU16(
  bytes: Uint8Array,
  offset: number,
): { value: number; bytesRead: number } {
  let value = 0;
  let bytesRead = 0;
  for (;;) {
    const byte = bytes[offset + bytesRead];
    if (byte === undefined) break;
    value |= (byte & 0x7f) << (7 * bytesRead);
    bytesRead += 1;
    if ((byte & 0x80) === 0) break;
  }
  return { value, bytesRead };
}

/**
 * True if a serialized transaction carries a versioned (v0+) message. The wire
 * format is `[sig_count (shortvec)][sig_count × 64 bytes][message]`, and a
 * versioned message sets the high bit of its first byte while a legacy message's
 * first byte (numRequiredSignatures) is < 128. The signature array MUST be skipped
 * first — the transaction's own leading byte is the signature COUNT, not the
 * version — so naive `bytes[0] & 0x80` is wrong.
 */
export function isVersionedTransactionBytes(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  const { value: sigCount, bytesRead } = readCompactU16(bytes, 0);
  const firstMessageByte = bytes[bytesRead + sigCount * 64];
  return firstMessageByte !== undefined && (firstMessageByte & 0x80) !== 0;
}
