import type { SignedAuthorization } from "viem";
import {
  type AccessList,
  type Address,
  type Hex,
  parseTransaction,
  type Signature,
  serializeTransaction,
  type TransactionSerializableEIP7702,
  type TransactionSerializedEIP7702,
} from "viem";

export const EIP7702_DELEGATION_PREFIX = "0xef0100";
const EIP7702_DELEGATION_CODE_LENGTH = EIP7702_DELEGATION_PREFIX.length + 40;
const HEX_CODE_RE = /^0x[0-9a-fA-F]*$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

export interface Eip7702DelegationStatus {
  walletAddress: string;
  chainId: number;
  delegated: boolean;
  implementationAddress: string | null;
  code: string;
}

export interface ReadEip7702DelegationOptions {
  walletAddress: string;
  chainId: number;
  getCode: (address: string, blockTag: "latest") => Promise<unknown>;
}

export interface Eip7702SignedAuthorizationInput {
  contractAddress?: string;
  address?: string;
  chainId: number;
  nonce: number;
  r: string;
  s: string;
  yParity: 0 | 1;
}

export interface Eip7702TransactionInput {
  chainId: number;
  authorizationList: Eip7702SignedAuthorizationInput[];
  nonce?: number;
  to?: string | null;
  value?: bigint | number | string;
  data?: string;
  gas?: bigint | number | string;
  maxFeePerGas?: bigint | number | string;
  maxPriorityFeePerGas?: bigint | number | string;
  accessList?: AccessList;
}

export interface Eip7702ParsedTransaction {
  type: "eip7702";
  chainId: number;
  nonce?: number;
  to?: string;
  value?: bigint;
  data?: string;
  gas?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  accessList: AccessList;
  authorizationList: Eip7702SignedAuthorizationInput[];
  rawTransaction: TransactionSerializedEIP7702;
}

export interface Eip7702BroadcastRequest {
  chainId: number;
  rawTransaction: TransactionSerializedEIP7702;
  rpcRequest: {
    method: "eth_sendRawTransaction";
    params: [TransactionSerializedEIP7702];
    chainId: number;
  };
}

export function parseEip7702DelegatedImplementation(
  code: unknown,
): string | null {
  if (typeof code !== "string" || !HEX_CODE_RE.test(code)) {
    throw new Error("eth_getCode returned invalid hex code");
  }

  if (code === "0x") return null;

  const normalized = code.toLowerCase();
  if (!normalized.startsWith(EIP7702_DELEGATION_PREFIX)) return null;

  if (normalized.length !== EIP7702_DELEGATION_CODE_LENGTH) {
    throw new Error("eth_getCode returned malformed EIP-7702 delegation code");
  }

  const implementationAddress = `0x${normalized.slice(EIP7702_DELEGATION_PREFIX.length)}`;
  if (!ADDRESS_RE.test(implementationAddress)) {
    throw new Error(
      "eth_getCode returned malformed EIP-7702 implementation address",
    );
  }

  return implementationAddress;
}

export async function readEip7702Delegation(
  options: ReadEip7702DelegationOptions,
): Promise<Eip7702DelegationStatus> {
  const code = await options.getCode(options.walletAddress, "latest");
  const implementationAddress = parseEip7702DelegatedImplementation(code);

  return {
    walletAddress: options.walletAddress,
    chainId: options.chainId,
    delegated: implementationAddress !== null,
    implementationAddress,
    code: code as string,
  };
}

function assertSafeUint32(
  value: number,
  field: string,
  allowZero = true,
): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    (!allowZero && value === 0)
  ) {
    throw new Error(
      `${field} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`,
    );
  }
  if (value > 0xffffffff) {
    throw new Error(`${field} exceeds EIP-7702 uint32 bounds`);
  }
  return value;
}

function assertAddress(value: string | undefined, field: string): Address {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) {
    throw new Error(`${field} must be an Ethereum address`);
  }
  return value as Address;
}

function assertHex(value: string | undefined, field: string): Hex | undefined {
  if (value === undefined) return undefined;
  if (!HEX_CODE_RE.test(value)) throw new Error(`${field} must be hex`);
  return value as Hex;
}

function toQuantity(
  value: bigint | number | string | undefined,
  field: string,
): bigint | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "bigint") {
    if (value < 0n) throw new Error(`${field} must be non-negative`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${field} must be a non-negative safe integer`);
    }
    return BigInt(value);
  }
  if (!/^\d+$/.test(value))
    throw new Error(`${field} must be a decimal string`);
  return BigInt(value);
}

function signedAuthorizationYParity(
  authorization: SignedAuthorization,
  field = "authorization yParity",
): 0 | 1 {
  if (authorization.yParity === 0 || authorization.yParity === 1)
    return authorization.yParity;
  if ("v" in authorization) {
    if (authorization.v === 0n || authorization.v === 27n) return 0;
    if (authorization.v === 1n || authorization.v === 28n) return 1;
  }
  throw new Error(`${field} must be 0 or 1`);
}

export function toEip7702SignedAuthorization(
  authorization: Eip7702SignedAuthorizationInput,
): SignedAuthorization {
  const address = assertAddress(
    authorization.address ?? authorization.contractAddress,
    "authorization address",
  );
  assertSafeUint32(authorization.chainId, "authorization chainId");
  assertSafeUint32(authorization.nonce, "authorization nonce");
  if (!BYTES32_RE.test(authorization.r))
    throw new Error("authorization r must be 32-byte hex");
  if (!BYTES32_RE.test(authorization.s))
    throw new Error("authorization s must be 32-byte hex");
  if (authorization.yParity !== 0 && authorization.yParity !== 1) {
    throw new Error("authorization yParity must be 0 or 1");
  }

  return {
    address,
    chainId: authorization.chainId,
    nonce: authorization.nonce,
    r: authorization.r as Hex,
    s: authorization.s as Hex,
    yParity: authorization.yParity,
  };
}

export function assembleEip7702Transaction(
  input: Eip7702TransactionInput,
): TransactionSerializableEIP7702 {
  assertSafeUint32(input.chainId, "chainId", false);
  if (
    !Array.isArray(input.authorizationList) ||
    input.authorizationList.length === 0
  ) {
    throw new Error(
      "authorizationList must contain at least one signed authorization",
    );
  }

  const transaction: TransactionSerializableEIP7702 = {
    type: "eip7702",
    chainId: input.chainId,
    accessList: input.accessList ?? [],
    authorizationList: input.authorizationList.map(
      toEip7702SignedAuthorization,
    ),
  };
  if (input.nonce !== undefined)
    transaction.nonce = assertSafeUint32(input.nonce, "nonce");
  if (input.to !== undefined && input.to !== null)
    transaction.to = assertAddress(input.to, "to");
  const value = toQuantity(input.value, "value");
  if (value !== undefined) transaction.value = value;
  const data = assertHex(input.data, "data");
  if (data !== undefined) transaction.data = data;
  const gas = toQuantity(input.gas, "gas");
  if (gas !== undefined) transaction.gas = gas;
  const maxFeePerGas = toQuantity(input.maxFeePerGas, "maxFeePerGas");
  if (maxFeePerGas !== undefined) transaction.maxFeePerGas = maxFeePerGas;
  const maxPriorityFeePerGas = toQuantity(
    input.maxPriorityFeePerGas,
    "maxPriorityFeePerGas",
  );
  if (maxPriorityFeePerGas !== undefined) {
    transaction.maxPriorityFeePerGas = maxPriorityFeePerGas;
  }

  return transaction;
}

export function serializeEip7702Transaction(
  input: Eip7702TransactionInput,
  signature?: Signature,
): TransactionSerializedEIP7702 {
  return serializeTransaction(assembleEip7702Transaction(input), signature);
}

export function parseEip7702Transaction(
  rawTransaction: string,
): Eip7702ParsedTransaction {
  if (!HEX_CODE_RE.test(rawTransaction))
    throw new Error("rawTransaction must be hex");
  if (!rawTransaction.toLowerCase().startsWith("0x04")) {
    throw new Error("rawTransaction must be an EIP-7702 type-4 transaction");
  }
  const transaction = parseTransaction(
    rawTransaction as TransactionSerializedEIP7702,
  ) as TransactionSerializableEIP7702;
  if (transaction.type !== "eip7702") {
    throw new Error("rawTransaction must be an EIP-7702 type-4 transaction");
  }

  return {
    type: "eip7702",
    chainId: transaction.chainId,
    nonce: transaction.nonce,
    to: transaction.to ?? undefined,
    value: transaction.value,
    data: transaction.data,
    gas: transaction.gas,
    maxFeePerGas: transaction.maxFeePerGas,
    maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
    accessList: transaction.accessList ?? [],
    authorizationList: transaction.authorizationList.map((authorization) => {
      const yParity = signedAuthorizationYParity(authorization);
      const normalized = toEip7702SignedAuthorization({
        address: authorization.address,
        contractAddress: authorization.address,
        chainId: authorization.chainId,
        nonce: authorization.nonce,
        r: authorization.r,
        s: authorization.s,
        yParity,
      });
      return {
        address: normalized.address,
        contractAddress: normalized.address,
        chainId: normalized.chainId,
        nonce: normalized.nonce,
        r: normalized.r,
        s: normalized.s,
        yParity,
      };
    }),
    rawTransaction: rawTransaction as TransactionSerializedEIP7702,
  };
}

export function buildEip7702BroadcastRequest(
  chainId: number,
  rawTransaction: string,
): Eip7702BroadcastRequest {
  assertSafeUint32(chainId, "chainId", false);
  const parsed = parseEip7702Transaction(rawTransaction);
  if (parsed.chainId !== chainId) {
    throw new Error("rawTransaction chainId does not match broadcast chainId");
  }
  return {
    chainId,
    rawTransaction: parsed.rawTransaction,
    rpcRequest: {
      method: "eth_sendRawTransaction",
      params: [parsed.rawTransaction],
      chainId,
    },
  };
}
