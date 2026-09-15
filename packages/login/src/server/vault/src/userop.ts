/**
 * ERC-4337 user-operation hashing for EntryPoint v0.7.
 *
 * Packed userOp form per the v0.7 spec:
 *   sender, nonce, initCode, callData, accountGasLimits (bytes32),
 *   preVerificationGas, gasFees (bytes32), paymasterAndData, signature
 *
 * The hash that an account's `validateUserOp` typically verifies is:
 *   keccak256(abi.encode(
 *     keccak256(abi.encode(
 *       sender, nonce, keccak256(initCode), keccak256(callData),
 *       accountGasLimits, preVerificationGas, gasFees,
 *       keccak256(paymasterAndData)
 *     )),
 *     entryPoint,
 *     chainId
 *   ))
 *
 * Reference accounts (SimpleAccount, Kernel, LightAccount) wrap this with
 * the EIP-191 personal-sign prefix before ECDSA verification. Callers can
 * sign the raw 32-byte hash or the prefixed digest depending on the account.
 */

import {
  encodeAbiParameters,
  type Hex,
  hashMessage,
  keccak256,
  pad,
  toHex,
} from "viem";

export interface PackedUserOperation {
  sender: Hex;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex; // verificationGasLimit (16) || callGasLimit (16)
  preVerificationGas: bigint;
  gasFees: Hex; // maxPriorityFeePerGas (16) || maxFeePerGas (16)
  paymasterAndData: Hex;
  signature?: Hex;
}

export interface UnpackedUserOperationFields {
  sender: Hex;
  nonce: bigint;
  initCode?: Hex;
  callData: Hex;
  verificationGasLimit: bigint;
  callGasLimit: bigint;
  preVerificationGas: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  paymasterAndData?: Hex;
}

export function packUints(high: bigint, low: bigint): Hex {
  const max128 = (1n << 128n) - 1n;
  if (high < 0n || high > max128 || low < 0n || low > max128) {
    throw new Error("packUints: values must fit in uint128");
  }
  return pad(toHex((high << 128n) | low), { size: 32 });
}

export function packUserOperation(
  op: UnpackedUserOperationFields,
): PackedUserOperation {
  return {
    sender: op.sender,
    nonce: op.nonce,
    initCode: op.initCode ?? "0x",
    callData: op.callData,
    accountGasLimits: packUints(op.verificationGasLimit, op.callGasLimit),
    preVerificationGas: op.preVerificationGas,
    gasFees: packUints(op.maxPriorityFeePerGas, op.maxFeePerGas),
    paymasterAndData: op.paymasterAndData ?? "0x",
  };
}

export function getUserOperationHash(
  op: PackedUserOperation,
  entryPoint: Hex,
  chainId: number | bigint,
): Hex {
  const inner = keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        op.sender,
        op.nonce,
        keccak256(op.initCode),
        keccak256(op.callData),
        op.accountGasLimits,
        op.preVerificationGas,
        op.gasFees,
        keccak256(op.paymasterAndData),
      ],
    ),
  );
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
      [inner, entryPoint, BigInt(chainId)],
    ),
  );
}

export function getUserOperationDigest(
  op: PackedUserOperation,
  entryPoint: Hex,
  chainId: number | bigint,
): Hex {
  return hashMessage({ raw: getUserOperationHash(op, entryPoint, chainId) });
}

/** Canonical EntryPoint v0.7 deployment address (same on every chain it ships on). */
export const ENTRY_POINT_V07 =
  "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const;
