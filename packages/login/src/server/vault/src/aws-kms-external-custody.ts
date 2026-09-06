import { isIP } from "node:net";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  type Address,
  createPublicClient,
  getAddress,
  type Hex,
  http,
  isAddress,
  isHex,
  keccak256,
  recoverAddress,
  serializeTransaction,
  type TransactionSerializableLegacy,
} from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { requireLoginValue } from "../../../required";
import type {
  ExternalKeyCustodyProvider,
  ExternalKeyHandleImportRequest,
  ExternalKeyHandleRegistration,
  ExternalKeySignTransactionRequest,
  ExternalKeySignTransactionResult,
} from "./external-key-custody";
import {
  assertNoExternalPrivateKeyMaterial,
  EXTERNAL_KEY_CUSTODY_CONTRACT_VERSION,
  ExternalBroadcastOutcomeUnknownError,
} from "./external-key-custody";

const AWS_PROVIDER_ID = "aws-kms";
const DEFAULT_EXTERNAL_REQUEST_TIMEOUT_MS = 10_000;
const SECP256K1_ORDER = BigInt(
  "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
);
const SECP256K1_HALF_ORDER = SECP256K1_ORDER / 2n;
// DER SubjectPublicKeyInfo prefix for ecPublicKey + secp256k1 followed by a
// 65-byte uncompressed SEC1 point. AWS KMS GetPublicKey uses this encoding.
const SECP256K1_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x56, 0x30, 0x10, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
  0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x0a, 0x03, 0x42, 0x00,
]);

interface AwsGetPublicKeyInput {
  KeyId: string;
}

interface AwsSignInput {
  KeyId: string;
  Message: Uint8Array;
  MessageType: "DIGEST";
  SigningAlgorithm: "ECDSA_SHA_256";
}

interface AwsGetPublicKeyOutput {
  KeyId?: string;
  PublicKey?: Uint8Array;
  KeySpec?: string;
  KeyUsage?: string;
  SigningAlgorithms?: string[];
}

interface AwsSignOutput {
  KeyId?: string;
  Signature?: Uint8Array;
  SigningAlgorithm?: string;
}

export interface AwsKmsSigningClientLike {
  send(
    command: unknown,
    options?: { abortSignal?: AbortSignal },
  ): Promise<unknown>;
}

export interface AwsKmsEvmRpc {
  getChainId(): Promise<number>;
  prepareTransaction(
    request: ExternalKeySignTransactionRequest,
    address: Address,
  ): Promise<TransactionSerializableLegacy>;
  broadcast(serializedTransaction: Hex): Promise<Hex>;
  /** Best-effort, read-only reconciliation after an ambiguous broadcast. */
  hasTransaction?(transactionHash: Hex): Promise<boolean>;
}

export interface AwsKmsExternalKeyCustodyOptions {
  client?: AwsKmsSigningClientLike;
  region?: string;
  rpcFactory?: (rpcUrl: string) => AwsKmsEvmRpc;
  maxGasLimit?: bigint;
  maxGasPriceWei?: bigint;
  maxTotalFeeWei?: bigint;
  requestTimeoutMs?: number;
}

function positiveBigIntEnv(name: string): bigint {
  const raw = process.env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw) || BigInt(raw) <= 0n) {
    throw new Error(`${name} is required and must be a positive integer`);
  }
  return BigInt(raw);
}

function bytesToHex(bytes: Uint8Array): Hex {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function hexToBytes(value: Hex): Uint8Array {
  const out = new Uint8Array((value.length - 2) / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(value.slice(2 + i * 2, 4 + i * 2), 16);
  }
  return out;
}

function unsignedBigIntToHex(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function readDerLength(
  bytes: Uint8Array,
  offset: number,
): { length: number; next: number } {
  const first = bytes[offset];
  if (first === undefined)
    throw new Error("AWS KMS returned a truncated ECDSA signature");
  if ((first & 0x80) === 0) return { length: first, next: offset + 1 };
  // KMS secp256k1 signatures are tiny. Reject non-minimal/oversized DER rather
  // than accepting an ambiguous ASN.1 encoding.
  const lengthBytes = first & 0x7f;
  if (
    lengthBytes !== 1 ||
    bytes[offset + 1] === undefined ||
    bytes[offset + 1] < 0x80
  ) {
    throw new Error("AWS KMS returned a non-canonical ECDSA signature length");
  }
  return { length: bytes[offset + 1], next: offset + 2 };
}

function readDerInteger(
  bytes: Uint8Array,
  offset: number,
): { value: bigint; next: number } {
  if (bytes[offset] !== 0x02)
    throw new Error("AWS KMS returned malformed ECDSA DER integers");
  const { length, next } = readDerLength(bytes, offset + 1);
  if (length < 1 || length > 33 || next + length > bytes.length) {
    throw new Error("AWS KMS returned an invalid ECDSA integer length");
  }
  const encoded = bytes.slice(next, next + length);
  if ((encoded[0] & 0x80) !== 0)
    throw new Error("AWS KMS returned a negative ECDSA integer");
  if (encoded.length > 1 && encoded[0] === 0 && (encoded[1] & 0x80) === 0) {
    throw new Error("AWS KMS returned a non-canonical ECDSA integer");
  }
  const magnitude = encoded[0] === 0 ? encoded.slice(1) : encoded;
  const hex = Array.from(magnitude, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return {
    value: hex.length === 0 ? 0n : BigInt(`0x${hex}`),
    next: next + length,
  };
}

/** Strictly decode the ASN.1 DER ECDSA signature returned by AWS KMS. */
export function decodeAwsKmsEcdsaSignature(signature: Uint8Array): {
  r: bigint;
  s: bigint;
} {
  if (signature.length < 8 || signature.length > 72 || signature[0] !== 0x30) {
    throw new Error("AWS KMS returned a malformed ECDSA signature");
  }
  const sequence = readDerLength(signature, 1);
  if (sequence.next + sequence.length !== signature.length) {
    throw new Error(
      "AWS KMS returned an ECDSA signature with trailing or truncated bytes",
    );
  }
  const r = readDerInteger(signature, sequence.next);
  const s = readDerInteger(signature, r.next);
  if (s.next !== signature.length) {
    throw new Error("AWS KMS returned an ECDSA signature with trailing bytes");
  }
  for (const [name, value] of [
    ["r", r.value],
    ["s", s.value],
  ] as const) {
    if (value <= 0n || value >= SECP256K1_ORDER) {
      throw new Error(
        `AWS KMS returned ECDSA ${name} outside the secp256k1 scalar range`,
      );
    }
  }
  return { r: r.value, s: s.value };
}

function evmAddressFromSpki(publicKey: Uint8Array): Address {
  if (publicKey.length !== SECP256K1_SPKI_PREFIX.length + 65) {
    throw new Error(
      "AWS KMS returned an invalid secp256k1 SPKI public key length",
    );
  }
  if (
    !SECP256K1_SPKI_PREFIX.every((byte, index) => publicKey[index] === byte)
  ) {
    throw new Error(
      "AWS KMS returned an SPKI key with an unexpected algorithm or encoding",
    );
  }
  const encodedPoint = publicKey.slice(SECP256K1_SPKI_PREFIX.length);
  let canonicalPoint: Uint8Array;
  try {
    canonicalPoint =
      secp256k1.ProjectivePoint.fromHex(encodedPoint).toRawBytes(false);
  } catch {
    throw new Error("AWS KMS returned a public key point outside secp256k1");
  }
  return getAddress(publicKeyToAddress(bytesToHex(canonicalPoint)));
}

function assertAwsSigningKey(output: AwsGetPublicKeyOutput): {
  keyId: string;
  publicKey: Uint8Array;
} {
  if (!output.KeyId?.trim())
    throw new Error("AWS KMS GetPublicKey did not return a canonical KeyId");
  if (!output.PublicKey)
    throw new Error("AWS KMS GetPublicKey did not return PublicKey");
  if (output.KeySpec !== "ECC_SECG_P256K1") {
    throw new Error(
      "AWS KMS external custody requires KeySpec ECC_SECG_P256K1",
    );
  }
  if (output.KeyUsage !== "SIGN_VERIFY") {
    throw new Error("AWS KMS external custody requires KeyUsage SIGN_VERIFY");
  }
  if (!output.SigningAlgorithms?.includes("ECDSA_SHA_256")) {
    throw new Error(
      "AWS KMS external custody requires ECDSA_SHA_256 signing support",
    );
  }
  return { keyId: output.KeyId, publicKey: output.PublicKey };
}

function assertEvmRequest(request: ExternalKeySignTransactionRequest): void {
  if (request.chainFamily !== "evm") {
    throw new Error(
      "AWS KMS reference custody supports EVM transaction signing only",
    );
  }
  if (request.handle.providerId !== AWS_PROVIDER_ID) {
    throw new Error(
      `AWS KMS external custody handle providerId must be ${AWS_PROVIDER_ID}`,
    );
  }
  if (!request.handle.keyId.trim())
    throw new Error("AWS KMS external custody requires keyId");
  if (!isAddress(request.address) || !isAddress(request.to)) {
    throw new Error("AWS KMS external custody requires valid EVM addresses");
  }
  if (!Number.isSafeInteger(request.chainId) || request.chainId <= 0) {
    throw new Error("AWS KMS external custody requires a positive EVM chainId");
  }
  if (BigInt(request.value) < 0n)
    throw new Error("AWS KMS external custody value cannot be negative");
  if (request.gasLimit !== undefined && BigInt(request.gasLimit) <= 0n) {
    throw new Error("AWS KMS external custody gasLimit must be positive");
  }
  if (
    request.nonce !== undefined &&
    (!Number.isSafeInteger(request.nonce) || request.nonce < 0)
  ) {
    throw new Error(
      "AWS KMS external custody nonce must be a non-negative safe integer",
    );
  }
  if (request.data !== undefined && !isHex(request.data)) {
    throw new Error("AWS KMS external custody data must be hex encoded");
  }
  if (!request.rpcUrl?.trim())
    throw new Error("AWS KMS external custody requires an EVM RPC URL");
  validateEvmRpcTransport(request.rpcUrl);
}

function isPrivateIpv4(host: string): boolean {
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet)))
    return false;
  const [first, second] = octets;
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function parseIpv6Words(host: string): number[] | null {
  const halves = host.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || omitted < 0) return null;
  const words = [...left, ...Array(omitted).fill("0"), ...right].map((word) =>
    Number.parseInt(word, 16),
  );
  return words.length === 8 && words.every((word) => Number.isInteger(word))
    ? words
    : null;
}

function isPrivateIpv6(host: string): boolean {
  const words = parseIpv6Words(host);
  if (!words) return false;
  const loopback =
    words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  const uniqueLocal = (words[0] & 0xfe00) === 0xfc00;
  const linkLocal = (words[0] & 0xffc0) === 0xfe80;
  const ipv4Mapped =
    words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  if (!ipv4Mapped) return loopback || uniqueLocal || linkLocal;
  return isPrivateIpv4(
    `${words[6] >> 8}.${words[6] & 0xff}.${words[7] >> 8}.${words[7] & 0xff}`,
  );
}

function isPrivateHttpHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host.endsWith(".localhost"))
    return true;
  const ipVersion = isIP(host);
  if (ipVersion === 4) return isPrivateIpv4(host);
  if (ipVersion === 6) return isPrivateIpv6(host);
  return false;
}

function validateEvmRpcTransport(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(
      "AWS KMS external custody EVM RPC must be a valid HTTP(S) URL",
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      "AWS KMS external custody EVM RPC must not embed URL credentials",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("AWS KMS external custody EVM RPC must use HTTP(S)");
  }
  if (parsed.protocol === "http:" && !isPrivateHttpHost(parsed.hostname)) {
    throw new Error(
      "AWS KMS external custody EVM RPC must use HTTPS for a non-private host",
    );
  }
}

function assertHandleRegion(
  handleRegion: string | undefined,
  configuredRegion: string,
): void {
  if (handleRegion !== configuredRegion) {
    throw new Error(
      "AWS KMS external custody handle region must match STEWARD_EXTERNAL_CUSTODY_AWS_REGION",
    );
  }
}

function assertAwsRegion(region: string | undefined): asserts region is string {
  if (!region || !/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(region)) {
    throw new Error(
      "STEWARD_EXTERNAL_CUSTODY_AWS_REGION is required and must be an explicit AWS region",
    );
  }
}

function assertCanonicalKmsKeyArn(keyId: string, region: string): void {
  const match =
    /^arn:(aws(?:-us-gov|-cn|-iso|-iso-b)?):kms:([a-z0-9-]+):(\d{12}):key\/([A-Za-z0-9-]+)$/.exec(
      keyId,
    );
  if (!match || match[2] !== region) {
    throw new Error(
      "AWS KMS external custody requires a canonical KMS key ARN in the configured region",
    );
  }
}

function defaultRpcFactory(rpcUrl: string, timeoutMs: number): AwsKmsEvmRpc {
  const client = createPublicClient({
    transport: http(rpcUrl, { retryCount: 0, timeout: timeoutMs }),
  });
  return {
    getChainId() {
      return client.getChainId();
    },
    async prepareTransaction(request, address) {
      const to = getAddress(request.to);
      const value = BigInt(request.value);
      const data = (request.data ?? "0x") as Hex;
      const nonce =
        request.nonce ??
        (await client.getTransactionCount({ address, blockTag: "pending" }));
      const gas = request.gasLimit
        ? BigInt(request.gasLimit)
        : await client.estimateGas({ account: address, to, value, data });
      const gasPrice = await client.getGasPrice();
      return {
        type: "legacy",
        chainId: request.chainId,
        to,
        value,
        data,
        nonce,
        gas,
        gasPrice,
      };
    },
    broadcast(serializedTransaction) {
      return client.sendRawTransaction({ serializedTransaction });
    },
    async hasTransaction(transactionHash) {
      try {
        const transaction = await client.getTransaction({
          hash: transactionHash,
        });
        return transaction.hash.toLowerCase() === transactionHash.toLowerCase();
      } catch {
        return false;
      }
    },
  };
}

export class AwsKmsExternalKeyCustodyProvider
  implements ExternalKeyCustodyProvider
{
  readonly id = "external-custody:aws-kms";
  readonly contractVersion = EXTERNAL_KEY_CUSTODY_CONTRACT_VERSION;

  private readonly clientIsInjected: boolean;
  private client?: AwsKmsSigningClientLike;
  private readonly region: string;
  private readonly rpcFactory: (rpcUrl: string) => AwsKmsEvmRpc;
  private readonly maxGasLimit?: bigint;
  private readonly maxGasPriceWei?: bigint;
  private readonly maxTotalFeeWei?: bigint;
  private readonly requestTimeoutMs: number;

  constructor(options: AwsKmsExternalKeyCustodyOptions = {}) {
    assertAwsRegion(options.region);
    this.client = options.client;
    this.clientIsInjected = Boolean(options.client);
    this.region = options.region;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_EXTERNAL_REQUEST_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.requestTimeoutMs) ||
      this.requestTimeoutMs <= 0
    ) {
      throw new Error(
        "AWS KMS external custody requestTimeoutMs must be a positive safe integer",
      );
    }
    this.rpcFactory =
      options.rpcFactory ??
      ((rpcUrl) => defaultRpcFactory(rpcUrl, this.requestTimeoutMs));
    this.maxGasLimit = options.maxGasLimit;
    this.maxGasPriceWei = options.maxGasPriceWei;
    this.maxTotalFeeWei = options.maxTotalFeeWei;
  }

  static fromEnv(): AwsKmsExternalKeyCustodyProvider {
    return new AwsKmsExternalKeyCustodyProvider({
      region: process.env.STEWARD_EXTERNAL_CUSTODY_AWS_REGION,
      maxGasLimit: positiveBigIntEnv(
        "STEWARD_EXTERNAL_CUSTODY_AWS_MAX_GAS_LIMIT",
      ),
      maxGasPriceWei: positiveBigIntEnv(
        "STEWARD_EXTERNAL_CUSTODY_AWS_MAX_GAS_PRICE_WEI",
      ),
      maxTotalFeeWei: positiveBigIntEnv(
        "STEWARD_EXTERNAL_CUSTODY_AWS_MAX_TOTAL_FEE_WEI",
      ),
    });
  }

  async registerKeyHandle(
    request: ExternalKeyHandleImportRequest,
  ): Promise<ExternalKeyHandleRegistration> {
    assertNoExternalPrivateKeyMaterial(request);
    assertHandleRegion(request.handle.region, this.region);
    if (request.chainFamily !== "evm") {
      throw new Error(
        "AWS KMS reference custody supports EVM key handles only",
      );
    }
    if (
      request.handle.providerId !== AWS_PROVIDER_ID ||
      !request.handle.keyId.trim()
    ) {
      throw new Error(
        `AWS KMS external custody handle requires providerId=${AWS_PROVIDER_ID} and keyId`,
      );
    }
    assertCanonicalKmsKeyArn(request.handle.keyId, this.region);
    if (!isAddress(request.address)) {
      throw new Error(
        "AWS KMS external custody registration requires a valid EVM address",
      );
    }
    const resolved = await this.resolveSigningIdentity(request.handle.keyId);
    if (resolved.keyId !== request.handle.keyId) {
      throw new Error(
        "AWS KMS external custody registration requires the canonical KMS KeyId",
      );
    }
    if (resolved.address !== getAddress(request.address)) {
      throw new Error(
        "AWS KMS public key does not match the requested external wallet address",
      );
    }
    return {
      custody: "external",
      tenantId: request.tenantId,
      agentId: request.agentId,
      chainFamily: "evm",
      address: resolved.address,
      handle: {
        providerId: AWS_PROVIDER_ID,
        keyId: request.handle.keyId,
        version: request.handle.version,
        region: this.region,
      },
      venue: request.venue ?? null,
      purpose: request.purpose ?? null,
      metadata: request.metadata ?? {},
      registeredAt: new Date(),
      exportablePrivateKey: false,
      signingAvailability: "provider-signing",
    };
  }

  async exportKeyHandle(): Promise<never> {
    throw new Error(
      "AWS KMS external custody key handles are not exportable through Steward",
    );
  }

  async signTransaction(
    request: ExternalKeySignTransactionRequest,
  ): Promise<ExternalKeySignTransactionResult> {
    assertNoExternalPrivateKeyMaterial(request);
    assertEvmRequest(request);
    assertHandleRegion(request.handle.region, this.region);
    assertCanonicalKmsKeyArn(request.handle.keyId, this.region);
    const expectedAddress = getAddress(request.address);
    const resolvedIdentity = await this.resolveSigningIdentity(
      request.handle.keyId,
    );
    if (resolvedIdentity.keyId !== request.handle.keyId) {
      throw new Error(
        "AWS KMS external custody handle is not pinned to the canonical KMS KeyId",
      );
    }
    if (resolvedIdentity.address !== expectedAddress) {
      throw new Error(
        "AWS KMS public key no longer matches the registered external wallet address",
      );
    }

    const rpc = this.rpcFactory(
      requireLoginValue(request.rpcUrl, "request.rpcUrl"),
    );
    if (
      (await this.withDeadline(rpc.getChainId(), "RPC chain lookup")) !==
      request.chainId
    ) {
      throw new Error("AWS KMS RPC endpoint is connected to the wrong chainId");
    }
    const transaction = await this.withDeadline(
      rpc.prepareTransaction(request, expectedAddress),
      "RPC transaction preparation",
    );
    if (transaction.type !== undefined && transaction.type !== "legacy") {
      throw new Error(
        "AWS KMS reference custody supports legacy EIP-155 transactions only",
      );
    }
    if (transaction.chainId !== request.chainId) {
      throw new Error(
        "AWS KMS RPC prepared a transaction for the wrong chainId",
      );
    }
    if (
      !transaction.to ||
      getAddress(transaction.to) !== getAddress(request.to)
    ) {
      throw new Error(
        "AWS KMS RPC prepared a transaction for the wrong recipient",
      );
    }
    if ((transaction.value ?? 0n) !== BigInt(request.value)) {
      throw new Error(
        "AWS KMS RPC prepared a transaction with the wrong value",
      );
    }
    if (
      (transaction.data ?? "0x").toLowerCase() !==
      (request.data ?? "0x").toLowerCase()
    ) {
      throw new Error(
        "AWS KMS RPC prepared a transaction with the wrong calldata",
      );
    }
    if (request.nonce !== undefined && transaction.nonce !== request.nonce) {
      throw new Error(
        "AWS KMS RPC prepared a transaction with the wrong nonce",
      );
    }
    if (
      request.gasLimit !== undefined &&
      transaction.gas !== BigInt(request.gasLimit)
    ) {
      throw new Error(
        "AWS KMS RPC prepared a transaction with the wrong gas limit",
      );
    }
    if (!this.maxGasLimit || !this.maxGasPriceWei || !this.maxTotalFeeWei) {
      throw new Error("AWS KMS external custody fee maxima are not configured");
    }
    if (
      !transaction.gas ||
      transaction.gas <= 0n ||
      transaction.gas > this.maxGasLimit
    ) {
      throw new Error(
        "AWS KMS RPC prepared a transaction above the configured gas limit maximum",
      );
    }
    if (
      !transaction.gasPrice ||
      transaction.gasPrice <= 0n ||
      transaction.gasPrice > this.maxGasPriceWei
    ) {
      throw new Error(
        "AWS KMS RPC prepared a transaction above the configured gas price maximum",
      );
    }
    if (transaction.gas * transaction.gasPrice > this.maxTotalFeeWei) {
      throw new Error(
        "AWS KMS RPC prepared a transaction above the configured total fee maximum",
      );
    }

    const unsigned = serializeTransaction(transaction);
    const digest = keccak256(unsigned);
    const response = (await this.sendKms(
      await this.createSignCommand({
        KeyId: request.handle.keyId,
        Message: hexToBytes(digest),
        MessageType: "DIGEST",
        SigningAlgorithm: "ECDSA_SHA_256",
      }),
    )) as AwsSignOutput;
    if (!response.Signature)
      throw new Error("AWS KMS Sign did not return Signature");
    if (response.KeyId !== request.handle.keyId) {
      throw new Error("AWS KMS Sign returned a different canonical KeyId");
    }
    if (response.SigningAlgorithm !== "ECDSA_SHA_256") {
      throw new Error("AWS KMS Sign returned an unexpected signing algorithm");
    }

    const decoded = decodeAwsKmsEcdsaSignature(response.Signature);
    const normalizedS =
      decoded.s > SECP256K1_HALF_ORDER
        ? SECP256K1_ORDER - decoded.s
        : decoded.s;
    const r = unsignedBigIntToHex(decoded.r);
    const s = unsignedBigIntToHex(normalizedS);
    let yParity: 0 | 1 | undefined;
    for (const candidate of [0, 1] as const) {
      const recovered = getAddress(
        await recoverAddress({
          hash: digest,
          signature: { r, s, yParity: candidate },
        }),
      );
      if (recovered === expectedAddress) {
        yParity = candidate;
        break;
      }
    }
    if (yParity === undefined) {
      throw new Error(
        "AWS KMS signature does not recover to the registered external wallet address",
      );
    }
    const serialized = serializeTransaction(transaction, {
      r,
      s,
      // Legacy EIP-155 serialization consumes v (27/28) and derives the
      // chain-bound value itself. yParity above remains the recovery proof.
      v: yParity === 0 ? 27n : 28n,
    });
    const expectedTransactionHash = keccak256(serialized);
    let result: Hex = serialized;
    if (request.broadcast) {
      if (!request.onPreparedBroadcast) {
        throw new Error(
          "AWS KMS broadcasts require a durable pre-broadcast checkpoint",
        );
      }
      await request.onPreparedBroadcast(expectedTransactionHash);
      try {
        result = await this.withDeadline(
          rpc.broadcast(serialized),
          "RPC broadcast",
        );
      } catch (cause) {
        // sendRawTransaction can mutate the chain before its response is lost.
        // Reconcile once by the deterministic local hash; never blindly retry.
        const reconciled = rpc.hasTransaction
          ? await this.withDeadline(
              rpc.hasTransaction(expectedTransactionHash),
              "RPC broadcast reconciliation",
            ).catch(() => false)
          : false;
        if (reconciled) {
          result = expectedTransactionHash;
        } else {
          throw new ExternalBroadcastOutcomeUnknownError(
            expectedTransactionHash,
            { cause },
          );
        }
      }
      if (
        typeof result !== "string" ||
        result.toLowerCase() !== expectedTransactionHash.toLowerCase()
      ) {
        // Submission may already have succeeded even if the RPC response is
        // dishonest or corrupt. Preserve the ambiguous outcome so callers
        // cannot safely retry the signed bytes.
        throw new ExternalBroadcastOutcomeUnknownError(
          expectedTransactionHash,
          {
            cause: new Error(
              "AWS KMS RPC returned a mismatched transaction hash",
            ),
          },
        );
      }
    }
    return { result, broadcast: request.broadcast };
  }

  private async resolveSigningIdentity(
    keyId: string,
  ): Promise<{ address: Address; keyId: string }> {
    const response = (await this.sendKms(
      await this.createGetPublicKeyCommand({ KeyId: keyId }),
    )) as AwsGetPublicKeyOutput;
    const signingKey = assertAwsSigningKey(response);
    return {
      address: evmAddressFromSpki(signingKey.publicKey),
      keyId: signingKey.keyId,
    };
  }

  private async sendKms(command: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await this.withDeadline(
        (await this.getClient()).send(command, {
          abortSignal: controller.signal,
        }),
        "KMS request",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async withDeadline<T>(
    promise: Promise<T>,
    operation: string,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error(`AWS KMS external custody ${operation} timed out`)),
        this.requestTimeoutMs,
      );
    });
    try {
      return await Promise.race([promise, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async getClient(): Promise<AwsKmsSigningClientLike> {
    if (this.client) return this.client;
    const moduleName = "@aws-sdk/client-kms";
    const aws = (await import(moduleName)) as {
      KMSClient: new (options: { region?: string }) => AwsKmsSigningClientLike;
    };
    this.client = new aws.KMSClient({ region: this.region });
    return this.client;
  }

  private async createGetPublicKeyCommand(
    input: AwsGetPublicKeyInput,
  ): Promise<unknown> {
    if (this.clientIsInjected)
      return { commandName: "GetPublicKeyCommand", input };
    const moduleName = "@aws-sdk/client-kms";
    const aws = (await import(moduleName)) as {
      GetPublicKeyCommand: new (input: AwsGetPublicKeyInput) => unknown;
    };
    return new aws.GetPublicKeyCommand(input);
  }

  private async createSignCommand(input: AwsSignInput): Promise<unknown> {
    if (this.clientIsInjected) return { commandName: "SignCommand", input };
    const moduleName = "@aws-sdk/client-kms";
    const aws = (await import(moduleName)) as {
      SignCommand: new (input: AwsSignInput) => unknown;
    };
    return new aws.SignCommand(input);
  }
}

export { AWS_PROVIDER_ID as AWS_KMS_EXTERNAL_CUSTODY_PROVIDER_ID };
