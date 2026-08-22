/**
 * Provides a resettable Base-compatible JSON-RPC chain simulator for driving
 * production wallet HTTP transports without provider traffic or retained keys.
 */

import { createHash } from "node:crypto";
import {
  type Address,
  type Hex,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerialized,
} from "viem";
import { startFetchServer } from "../fetch-server";

export type EvmRpcMockFault =
  | "rate_limit"
  | "provider_error"
  | "malformed_json"
  | "stall"
  | "stall_after_accept";

export interface EvmRpcMockSeed {
  chainId: number;
  blockNumber: number;
  timestamp: number;
  blockTimeSeconds: number;
  balances: Record<string, bigint>;
  revertRecipients: string[];
  bearerToken?: string;
}

export interface EvmRpcMockObservation {
  order: number;
  generation: number;
  method: string;
  requestId?: string | number | null;
  authorized: boolean;
  outcome:
    | "success"
    | "accepted"
    | "duplicate"
    | "unauthorized"
    | "rate_limited"
    | "provider_error"
    | "malformed"
    | "stalled"
    | "cancelled"
    | "reset";
  params?: unknown[];
  transactionHash?: Hex;
  rawTransactionBytes?: number;
  responseFault?: "stalled";
}

interface StoredTransaction {
  hash: Hex;
  raw: Hex;
  from: Address;
  to?: Address;
  value: bigint;
  nonce: number;
  state: "pending" | "mined";
  receipt: Record<string, unknown> | null;
}

interface AppliedEffect {
  transactionHash: Hex;
  from: Address;
  to?: Address;
  previousFromBalance: bigint;
  previousToBalance?: bigint;
  previousNonce: number;
}

interface MinedBlock {
  number: number;
  hash: Hex;
  effects: AppliedEffect[];
}

interface PendingResponse {
  generation: number;
  settle: (response: Response) => void;
}

const DEFAULT_SEED: EvmRpcMockSeed = {
  chainId: 8453,
  blockNumber: 100,
  timestamp: 1_800_000_000,
  blockTimeSeconds: 2,
  balances: {},
  revertRecipients: [],
};

export const EVM_RPC_MAX_REQUEST_BYTES = 64 * 1024;
const EVM_RPC_MAX_JSON_DEPTH = 16;
const EVM_RPC_MAX_JSON_NODES = 2_048;

const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;
const ZERO_BLOOM = `0x${"0".repeat(512)}` as Hex;
const ZERO_ADDRESS = `0x${"0".repeat(40)}` as Address;

export class EvmRpcMockStore {
  #generation = 1;
  #seed: EvmRpcMockSeed;
  #blockNumber: number;
  #timestamp: number;
  #fork = 0;
  #fault: { kind: EvmRpcMockFault; method?: string } | null = null;
  #balances = new Map<string, bigint>();
  #nonces = new Map<string, number>();
  #transactions = new Map<Hex, StoredTransaction>();
  #blocks: MinedBlock[] = [];
  #blockHashes = new Map<number, Hex>();
  #observations: EvmRpcMockObservation[] = [];
  #pendingResponses = new Set<PendingResponse>();

  constructor(seed: Partial<EvmRpcMockSeed> = {}) {
    this.#seed = normalizeSeed(seed);
    this.#blockNumber = this.#seed.blockNumber;
    this.#timestamp = this.#seed.timestamp;
    this.#loadSeed();
  }

  get generation(): number {
    return this.#generation;
  }

  get pendingResponseCount(): number {
    return this.#pendingResponses.size;
  }

  setFault(kind: EvmRpcMockFault | null, method?: string): void {
    this.#fault = kind ? { kind, method } : null;
  }

  reset(seed: Partial<EvmRpcMockSeed> = {}): void {
    const staleResponses = [...this.#pendingResponses];
    this.#generation += 1;
    this.#seed = normalizeSeed(seed, this.#seed);
    this.#blockNumber = this.#seed.blockNumber;
    this.#timestamp = this.#seed.timestamp;
    this.#fork = 0;
    this.#fault = null;
    this.#observations = [];
    this.#transactions.clear();
    this.#blocks = [];
    this.#pendingResponses.clear();
    this.#loadSeed();
    for (const pending of staleResponses) {
      pending.settle(
        jsonRpcHttpError(503, "Synthetic chain environment reset"),
      );
    }
  }

  mine(blockCount = 1): void {
    if (!Number.isSafeInteger(blockCount) || blockCount < 1) {
      throw new Error("blockCount must be a positive safe integer");
    }
    for (let index = 0; index < blockCount; index += 1) this.#mineOne();
  }

  reorg(depth = 1): void {
    if (
      !Number.isSafeInteger(depth) ||
      depth < 1 ||
      depth > this.#blocks.length
    ) {
      throw new Error("reorg depth must reference simulator-mined blocks");
    }
    for (let index = 0; index < depth; index += 1) {
      const block = this.#blocks.pop();
      if (!block) throw new Error("missing block during reorg");
      for (const effect of [...block.effects].reverse()) {
        this.#balances.set(
          normalizeAddress(effect.from),
          effect.previousFromBalance,
        );
        this.#nonces.set(normalizeAddress(effect.from), effect.previousNonce);
        if (effect.to && effect.previousToBalance !== undefined) {
          this.#balances.set(
            normalizeAddress(effect.to),
            effect.previousToBalance,
          );
        }
        const transaction = this.#transactions.get(effect.transactionHash);
        if (transaction) {
          transaction.state = "pending";
          transaction.receipt = null;
        }
      }
      this.#blockHashes.delete(block.number);
      this.#blockNumber -= 1;
      this.#timestamp -= this.#seed.blockTimeSeconds;
    }
    this.#fork += 1;
  }

  readback(): {
    generation: number;
    chainId: number;
    blockNumber: number;
    timestamp: number;
    fault: { kind: EvmRpcMockFault; method?: string } | null;
    balances: Record<string, string>;
    transactions: Array<{
      hash: Hex;
      from: Address;
      to?: Address;
      value: string;
      nonce: number;
      state: "pending" | "mined";
    }>;
    observations: EvmRpcMockObservation[];
  } {
    return {
      generation: this.#generation,
      chainId: this.#seed.chainId,
      blockNumber: this.#blockNumber,
      timestamp: this.#timestamp,
      fault: this.#fault ? { ...this.#fault } : null,
      balances: Object.fromEntries(
        [...this.#balances.entries()].map(([address, balance]) => [
          address,
          balance.toString(),
        ]),
      ),
      transactions: [...this.#transactions.values()].map((transaction) => ({
        hash: transaction.hash,
        from: transaction.from,
        ...(transaction.to ? { to: transaction.to } : {}),
        value: transaction.value.toString(),
        nonce: transaction.nonce,
        state: transaction.state,
      })),
      observations: this.#observations.map((entry) => ({
        ...entry,
        params: entry.params ? structuredClone(entry.params) : undefined,
      })),
    };
  }

  async handle(request: Request): Promise<Response> {
    const generation = this.#generation;
    if (request.method !== "POST") {
      return new Response("JSON-RPC requires POST", { status: 405 });
    }
    let payload: JsonRpcRequest;
    try {
      payload = parseRequest(await readBoundedJsonRpcBody(request));
    } catch (error) {
      // error-policy:J3 untrusted JSON-RPC input becomes an explicit parse
      // error response and is never interpreted as a valid method call.
      if (error instanceof JsonRpcAdmissionError) {
        return jsonRpcHttpError(error.status, error.publicMessage);
      }
      return jsonRpcResponse(null, undefined, {
        code: -32700,
        message: "Invalid JSON-RPC request",
      });
    }

    const authorized = this.#isAuthorized(request);
    if (!authorized) {
      this.#observe(
        {
          method: payload.method,
          requestId: payload.id,
          authorized: false,
          outcome: "unauthorized",
          params: summarizeParams(payload.method, payload.params),
        },
        generation,
      );
      return jsonRpcHttpError(401, "Unauthorized");
    }

    const fault = this.#matchingFault(payload.method);
    if (fault === "rate_limit") {
      this.#observeFault(payload, "rate_limited", generation);
      return jsonRpcHttpError(429, "Rate limited", { "retry-after": "1" });
    }
    if (fault === "malformed_json") {
      this.#observeFault(payload, "malformed", generation);
      return new Response('{"jsonrpc":', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (fault === "provider_error") {
      this.#observeFault(payload, "provider_error", generation);
      return jsonRpcResponse(payload.id, undefined, {
        code: -32000,
        message: "Synthetic provider failure",
      });
    }
    if (fault === "stall") {
      this.#observeFault(payload, "stalled", generation);
      return this.#stall(request, payload, generation);
    }

    try {
      const { result, outcome, transactionHash } =
        await this.#dispatch(payload);
      this.#observe(
        {
          method: payload.method,
          requestId: payload.id,
          authorized: true,
          outcome,
          params: summarizeParams(payload.method, payload.params),
          ...(transactionHash ? { transactionHash } : {}),
          ...(payload.method === "eth_sendRawTransaction"
            ? { rawTransactionBytes: rawTransactionBytes(payload.params[0]) }
            : {}),
          ...(fault === "stall_after_accept" &&
          payload.method === "eth_sendRawTransaction"
            ? { responseFault: "stalled" as const }
            : {}),
        },
        generation,
      );
      if (
        fault === "stall_after_accept" &&
        payload.method === "eth_sendRawTransaction"
      ) {
        return this.#stall(request, payload, generation);
      }
      return jsonRpcResponse(payload.id, result);
    } catch (error) {
      // error-policy:J1 the synthetic provider boundary translates execution
      // failures into canonical JSON-RPC errors rather than successful results.
      this.#observeFault(payload, "provider_error", generation);
      const failure = publicRpcFailure(error);
      return jsonRpcResponse(payload.id, undefined, {
        code: failure.code,
        message: failure.message,
      });
    }
  }

  shutdown(): void {
    for (const pending of this.#pendingResponses) {
      pending.settle(jsonRpcHttpError(503, "Synthetic RPC stopped"));
    }
    this.#pendingResponses.clear();
  }

  #loadSeed(): void {
    this.#balances = new Map(
      Object.entries(this.#seed.balances).map(([address, balance]) => [
        normalizeAddress(address),
        balance,
      ]),
    );
    this.#nonces.clear();
    this.#blockHashes.clear();
    this.#blockHashes.set(
      this.#blockNumber,
      deterministicHash(
        `chain:${this.#seed.chainId}:block:${this.#blockNumber}:timestamp:${this.#timestamp}`,
      ),
    );
  }

  #isAuthorized(request: Request): boolean {
    if (!this.#seed.bearerToken) return true;
    return (
      request.headers.get("authorization") ===
      `Bearer ${this.#seed.bearerToken}`
    );
  }

  #matchingFault(method: string): EvmRpcMockFault | null {
    if (!this.#fault) return null;
    if (this.#fault.method && this.#fault.method !== method) return null;
    return this.#fault.kind;
  }

  async #dispatch(payload: JsonRpcRequest): Promise<{
    result: unknown;
    outcome: "success" | "accepted" | "duplicate";
    transactionHash?: Hex;
  }> {
    const success = (result: unknown) => ({
      result,
      outcome: "success" as const,
    });
    switch (payload.method) {
      case "web3_clientVersion":
        return success("elizaOS/synthetic-base/1.0");
      case "eth_chainId":
        return success(toQuantity(this.#seed.chainId));
      case "eth_blockNumber":
        return success(toQuantity(this.#blockNumber));
      case "eth_getBalance":
        return success(
          toQuantity(
            this.#balances.get(normalizeAddress(payload.params[0])) ?? 0n,
          ),
        );
      case "eth_getTransactionCount":
        return success(
          toQuantity(
            this.#nonces.get(normalizeAddress(payload.params[0])) ?? 0,
          ),
        );
      case "eth_getBlockByNumber":
        return success(this.#block(payload.params[0]));
      case "eth_call":
        return success("0x");
      case "eth_estimateGas":
        return success("0x5208");
      case "eth_gasPrice":
        return success("0x3b9aca00");
      case "eth_maxPriorityFeePerGas":
        return success("0x3b9aca00");
      case "eth_feeHistory":
        return success({
          oldestBlock: toQuantity(this.#blockNumber),
          baseFeePerGas: ["0x3b9aca00", "0x3b9aca00"],
          gasUsedRatio: [0],
          reward: [["0x3b9aca00"]],
        });
      case "eth_getCode":
        return success("0x");
      case "eth_sendRawTransaction":
        return this.#submit(payload.params[0]);
      case "eth_getTransactionReceipt":
        return success(
          this.#transactions.get(normalizeTransactionHash(payload.params[0]))
            ?.receipt ?? null,
        );
      case "eth_getTransactionByHash": {
        const transaction = this.#transactions.get(
          normalizeTransactionHash(payload.params[0]),
        );
        return success(
          transaction ? this.#transactionResponse(transaction) : null,
        );
      }
      default:
        throw new JsonRpcProtocolError(-32601, "Method not found");
    }
  }

  async #submit(rawValue: unknown): Promise<{
    result: Hex;
    outcome: "accepted" | "duplicate";
    transactionHash: Hex;
  }> {
    const raw = normalizeRawTransaction(rawValue);
    const serialized = raw as TransactionSerialized;
    const hash = keccak256(raw);
    if (this.#transactions.has(hash)) {
      return { result: hash, outcome: "duplicate", transactionHash: hash };
    }
    let parsed: ReturnType<typeof parseTransaction>;
    try {
      parsed = parseTransaction(serialized);
    } catch {
      throw new JsonRpcProtocolError(
        -32602,
        "Invalid signed transaction encoding",
      );
    }
    if (parsed.chainId !== this.#seed.chainId) {
      throw new JsonRpcProtocolError(-32602, "Wrong chain ID");
    }
    if (parsed.nonce === undefined) {
      throw new JsonRpcProtocolError(
        -32602,
        "Signed transaction nonce is required",
      );
    }
    let from: Address;
    try {
      from = await recoverTransactionAddress({
        serializedTransaction: serialized,
      });
    } catch {
      throw new JsonRpcProtocolError(
        -32602,
        "Invalid signed transaction signature",
      );
    }
    const fromKey = normalizeAddress(from);
    const pendingFrom = [...this.#transactions.values()].filter(
      (transaction) =>
        transaction.state === "pending" &&
        normalizeAddress(transaction.from) === fromKey,
    );
    const expectedNonce = (this.#nonces.get(fromKey) ?? 0) + pendingFrom.length;
    if (parsed.nonce !== expectedNonce) {
      throw new JsonRpcProtocolError(
        -32602,
        `Invalid nonce: expected ${expectedNonce}, received ${parsed.nonce}`,
      );
    }
    const reservedValue = pendingFrom.reduce(
      (total, transaction) => total + transaction.value,
      0n,
    );
    const balance = this.#balances.get(fromKey) ?? 0n;
    if (balance < reservedValue + (parsed.value ?? 0n)) {
      throw new JsonRpcProtocolError(
        -32000,
        "Insufficient funds for transaction value",
      );
    }
    const transaction: StoredTransaction = {
      hash,
      raw,
      from,
      ...(parsed.to ? { to: parsed.to } : {}),
      value: parsed.value ?? 0n,
      nonce: parsed.nonce,
      state: "pending",
      receipt: null,
    };
    this.#transactions.set(hash, transaction);
    return { result: hash, outcome: "accepted", transactionHash: hash };
  }

  #mineOne(): void {
    this.#blockNumber += 1;
    this.#timestamp += this.#seed.blockTimeSeconds;
    const parentHash =
      this.#blockHashes.get(this.#blockNumber - 1) ?? ZERO_HASH;
    const blockHash = deterministicHash(
      `chain:${this.#seed.chainId}:fork:${this.#fork}:block:${this.#blockNumber}:parent:${parentHash}`,
    );
    this.#blockHashes.set(this.#blockNumber, blockHash);
    const effects: AppliedEffect[] = [];
    for (const transaction of this.#transactions.values()) {
      if (transaction.state !== "pending") continue;
      const fromKey = normalizeAddress(transaction.from);
      const toKey = transaction.to
        ? normalizeAddress(transaction.to)
        : undefined;
      const previousFromBalance = this.#balances.get(fromKey) ?? 0n;
      const previousToBalance = toKey
        ? (this.#balances.get(toKey) ?? 0n)
        : undefined;
      const previousNonce = this.#nonces.get(fromKey) ?? 0;
      const admitted =
        transaction.nonce === previousNonce &&
        previousFromBalance >= transaction.value;
      const executionReverted =
        transaction.to !== undefined &&
        this.#seed.revertRecipients.includes(normalizeAddress(transaction.to));
      const succeeds = admitted && !executionReverted;
      if (admitted) {
        this.#nonces.set(fromKey, previousNonce + 1);
      }
      if (succeeds) {
        this.#balances.set(fromKey, previousFromBalance - transaction.value);
        if (toKey && previousToBalance !== undefined) {
          this.#balances.set(toKey, previousToBalance + transaction.value);
        }
      }
      effects.push({
        transactionHash: transaction.hash,
        from: transaction.from,
        ...(transaction.to ? { to: transaction.to } : {}),
        previousFromBalance,
        ...(previousToBalance !== undefined ? { previousToBalance } : {}),
        previousNonce,
      });
      transaction.state = "mined";
      transaction.receipt = this.#receipt(transaction, blockHash, succeeds);
    }
    this.#blocks.push({ number: this.#blockNumber, hash: blockHash, effects });
  }

  #block(tag: unknown): Record<string, unknown> | null {
    const number =
      tag === "latest" ? this.#blockNumber : Number(BigInt(String(tag)));
    if (number !== this.#blockNumber) return null;
    const hash = this.#blockHashes.get(number) ?? ZERO_HASH;
    return {
      number: toQuantity(number),
      hash,
      parentHash: this.#blockHashes.get(number - 1) ?? ZERO_HASH,
      nonce: "0x0000000000000000",
      sha3Uncles: ZERO_HASH,
      logsBloom: ZERO_BLOOM,
      transactionsRoot: ZERO_HASH,
      stateRoot: ZERO_HASH,
      receiptsRoot: ZERO_HASH,
      miner: ZERO_ADDRESS,
      difficulty: "0x0",
      totalDifficulty: "0x0",
      extraData: "0x",
      size: "0x1",
      gasLimit: "0x1c9c380",
      gasUsed: "0x0",
      timestamp: toQuantity(this.#timestamp),
      transactions: [],
      uncles: [],
      baseFeePerGas: "0x3b9aca00",
      mixHash: ZERO_HASH,
    };
  }

  #receipt(
    transaction: StoredTransaction,
    blockHash: Hex,
    succeeds: boolean,
  ): Record<string, unknown> {
    return {
      transactionHash: transaction.hash,
      transactionIndex: "0x0",
      blockHash,
      blockNumber: toQuantity(this.#blockNumber),
      from: transaction.from,
      to: transaction.to ?? null,
      cumulativeGasUsed: "0x5208",
      gasUsed: "0x5208",
      contractAddress: null,
      logs: [],
      logsBloom: ZERO_BLOOM,
      status: succeeds ? "0x1" : "0x0",
      effectiveGasPrice: "0x3b9aca00",
      type: "0x2",
    };
  }

  #transactionResponse(
    transaction: StoredTransaction,
  ): Record<string, unknown> {
    return {
      hash: transaction.hash,
      from: transaction.from,
      to: transaction.to ?? null,
      nonce: toQuantity(transaction.nonce),
      value: toQuantity(transaction.value),
      gas: "0x5208",
      gasPrice: "0x3b9aca00",
      input: "0x",
      blockHash: transaction.receipt?.blockHash ?? null,
      blockNumber: transaction.receipt?.blockNumber ?? null,
      transactionIndex: transaction.receipt ? "0x0" : null,
      type: "0x2",
      chainId: toQuantity(this.#seed.chainId),
      v: "0x0",
      r: ZERO_HASH,
      s: ZERO_HASH,
    };
  }

  #observeFault(
    payload: JsonRpcRequest,
    outcome: EvmRpcMockObservation["outcome"],
    generation: number,
  ): void {
    this.#observe(
      {
        method: payload.method,
        requestId: payload.id,
        authorized: true,
        outcome,
        params: summarizeParams(payload.method, payload.params),
      },
      generation,
    );
  }

  #observe(
    observation: Omit<EvmRpcMockObservation, "order" | "generation">,
    generation: number,
  ): void {
    if (generation !== this.#generation) return;
    this.#observations.push({
      ...observation,
      generation,
      order: this.#observations.length + 1,
    });
  }

  #stall(
    request: Request,
    payload: JsonRpcRequest,
    generation: number,
  ): Promise<Response> {
    return new Promise<Response>((resolve) => {
      let settled = false;
      let pending: PendingResponse;
      const onAbort = () => {
        this.#observeFault(payload, "cancelled", generation);
        pending.settle(jsonRpcHttpError(499, "Client closed request"));
      };
      const settle = (response: Response) => {
        if (settled) return;
        settled = true;
        request.signal.removeEventListener("abort", onAbort);
        this.#pendingResponses.delete(pending);
        resolve(response);
      };
      pending = { generation, settle };
      this.#pendingResponses.add(pending);
      if (request.signal.aborted) onAbort();
      else request.signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export async function startEvmRpcMock(
  seed: Partial<EvmRpcMockSeed> = {},
): Promise<{
  url: string;
  store: EvmRpcMockStore;
  stop(): Promise<void>;
}> {
  const store = new EvmRpcMockStore(seed);
  const server = await startFetchServer((request) => store.handle(request));
  return {
    url: `http://${server.hostname}:${server.port}`,
    store,
    stop: async () => {
      store.shutdown();
      await server.stop();
    },
  };
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params: unknown[];
}

class JsonRpcAdmissionError extends Error {
  constructor(
    readonly status: number,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = "JsonRpcAdmissionError";
  }
}

class JsonRpcProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "JsonRpcProtocolError";
  }
}

async function readBoundedJsonRpcBody(request: Request): Promise<unknown> {
  const contentType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new JsonRpcAdmissionError(415, "JSON-RPC requires application/json");
  }
  const contentEncoding = request.headers
    .get("content-encoding")
    ?.trim()
    .toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    throw new JsonRpcAdmissionError(
      415,
      "Compressed JSON-RPC bodies are unsupported",
    );
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) {
      throw new JsonRpcAdmissionError(400, "Invalid Content-Length");
    }
    if (Number(declaredLength) > EVM_RPC_MAX_REQUEST_BYTES) {
      throw new JsonRpcAdmissionError(413, "JSON-RPC body is too large");
    }
  }
  if (!request.body) {
    throw new JsonRpcAdmissionError(400, "JSON-RPC body is required");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > EVM_RPC_MAX_REQUEST_BYTES) {
        await reader.cancel("JSON-RPC body is too large");
        throw new JsonRpcAdmissionError(413, "JSON-RPC body is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new JsonRpcAdmissionError(400, "JSON-RPC body must be UTF-8");
  }
  const value = JSON.parse(text) as unknown;
  assertJsonRpcComplexity(value);
  return value;
}

function assertJsonRpcComplexity(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 1 },
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    nodes += 1;
    if (
      nodes > EVM_RPC_MAX_JSON_NODES ||
      current.depth > EVM_RPC_MAX_JSON_DEPTH
    ) {
      throw new JsonRpcAdmissionError(
        400,
        "JSON-RPC body exceeds structural limits",
      );
    }
    if (Array.isArray(current.value)) {
      for (const item of current.value) {
        pending.push({ value: item, depth: current.depth + 1 });
      }
    } else if (typeof current.value === "object" && current.value !== null) {
      for (const item of Object.values(current.value)) {
        pending.push({ value: item, depth: current.depth + 1 });
      }
    }
  }
}

function parseRequest(value: unknown): JsonRpcRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("JSON-RPC request must be an object");
  }
  const input = value as Record<string, unknown>;
  if (input.jsonrpc !== "2.0" || typeof input.method !== "string") {
    throw new Error("Invalid JSON-RPC request envelope");
  }
  if (input.params !== undefined && !Array.isArray(input.params)) {
    throw new Error("JSON-RPC params must be an array");
  }
  const id = input.id;
  if (id !== null && typeof id !== "string" && typeof id !== "number") {
    throw new Error("JSON-RPC id must be string, number, or null");
  }
  return {
    jsonrpc: "2.0",
    id,
    method: input.method,
    params: input.params ?? [],
  };
}

function normalizeSeed(
  seed: Partial<EvmRpcMockSeed>,
  base: EvmRpcMockSeed = DEFAULT_SEED,
): EvmRpcMockSeed {
  return {
    chainId: seed.chainId ?? base.chainId,
    blockNumber: seed.blockNumber ?? base.blockNumber,
    timestamp: seed.timestamp ?? base.timestamp,
    blockTimeSeconds: seed.blockTimeSeconds ?? base.blockTimeSeconds,
    balances: Object.fromEntries(
      Object.entries(seed.balances ?? base.balances).map(
        ([address, balance]) => [normalizeAddress(address), BigInt(balance)],
      ),
    ),
    revertRecipients: (seed.revertRecipients ?? base.revertRecipients).map(
      normalizeAddress,
    ),
    ...((seed.bearerToken ?? base.bearerToken)
      ? { bearerToken: seed.bearerToken ?? base.bearerToken }
      : {}),
  };
}

function normalizeAddress(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new JsonRpcProtocolError(-32602, "Expected a 20-byte EVM address");
  }
  return value.toLowerCase();
}

function normalizeRawTransaction(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) {
    throw new JsonRpcProtocolError(
      -32602,
      "Expected non-empty, even-length raw transaction bytes",
    );
  }
  return value.toLowerCase() as Hex;
}

function normalizeTransactionHash(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new JsonRpcProtocolError(
      -32602,
      "Expected a 32-byte transaction hash",
    );
  }
  return value.toLowerCase() as Hex;
}

function toQuantity(value: bigint | number): Hex {
  return `0x${BigInt(value).toString(16)}`;
}

function deterministicHash(input: string): Hex {
  return `0x${createHash("sha256").update(input).digest("hex")}`;
}

function summarizeParams(method: string, params: unknown[]): unknown[] {
  if (method !== "eth_sendRawTransaction") return structuredClone(params);
  return [{ rawTransactionBytes: rawTransactionBytes(params[0]) }];
}

function rawTransactionBytes(value: unknown): number {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value)
    ? (value.length - 2) / 2
    : 0;
}

function publicRpcFailure(error: unknown): {
  code: number;
  message: string;
} {
  if (error instanceof JsonRpcProtocolError) {
    return { code: error.code, message: error.message };
  }
  return { code: -32603, message: "Synthetic RPC execution failed" };
}

function jsonRpcResponse(
  id: string | number | null,
  result?: unknown,
  error?: { code: number; message: string },
): Response {
  return Response.json({
    jsonrpc: "2.0",
    id,
    ...(error ? { error } : { result }),
  });
}

function jsonRpcHttpError(
  status: number,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { error: message },
    { status, headers: { ...headers, "content-type": "application/json" } },
  );
}
