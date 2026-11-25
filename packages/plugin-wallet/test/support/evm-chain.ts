// spec/wallet/index.md, "A submitted operation retains one durable binding through reconciliation"
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Interface, Transaction, Wallet, id, keccak256, toQuantity } from "ethers";

export type Gateway = "pass" | "lost" | "refused" | "gatewayError" | "secondCopy" | "missingHash" | "nullHash" | "malformedHash" | "otherHash" | "uppercaseHash";

interface Call { readonly id: unknown; readonly method: string; readonly params: readonly unknown[] }
interface Answer { readonly result?: unknown; readonly error?: { readonly code: number; readonly message: string } }
interface Pooled { readonly hash: string; readonly from: string; readonly to: string; readonly value: bigint; readonly price: bigint; readonly gas: bigint; readonly tokens: bigint }
interface Mined extends Pooled { readonly block: number }

export interface Chain {
  readonly url: string;
  readonly recipient: string;
  readonly token: string;
  gateway: Gateway;
  automine: boolean;
  readonly sent: string[];
  readonly refusals: string[];
  /** @throws {never} */
  fund(address: string, wei: bigint): void;
  /** @throws {never} */
  grant(address: string, units: bigint): void;
  /** @throws {never} */
  balance(address: string): bigint;
  /** @throws {never} */
  tokens(address: string): bigint;
  /** @throws {never} */
  landed(hash: string): boolean;
  /** @throws {never} */
  mine(): void;
  close(): Promise<void>;
}

const chainId = 31337n;
const baseFee = 1_000_000_000n;
const tip = 1_000_000_000n;
const transferGas = 21_000n;
const erc20 = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address,uint256) returns (bool)",
]);

/** @throws {never} */
export function signedHash(raw: string): string {
  return keccak256(raw);
}

/** @throws {never} */
export async function startChain(): Promise<Chain> {
  const token = Wallet.createRandom().address;
  const balances = new Map<string, bigint>();
  const held = new Map<string, bigint>();
  const pool = new Map<string, Pooled>();
  const mined = new Map<string, Mined>();
  const blocks: string[][] = [[]];
  const balance = (address: string) => balances.get(address.toLowerCase()) ?? 0n;
  const tokens = (address: string) => held.get(address.toLowerCase()) ?? 0n;
  const minedNonce = (address: string) => [...mined.values()].filter((tx) => tx.from === address.toLowerCase()).length;
  const pendingNonce = (address: string) => minedNonce(address) + [...pool.values()].filter((tx) => tx.from === address.toLowerCase()).length;
  const mine = () => {
    const included = [...pool.values()];
    for (const tx of included) {
      balances.set(tx.from, balance(tx.from) - tx.value - tx.gas * tx.price);
      if (tx.tokens === 0n) balances.set(tx.to, balance(tx.to) + tx.value);
      else {
        held.set(tx.from, tokens(tx.from) - tx.tokens);
        held.set(tx.to, tokens(tx.to) + tx.tokens);
      }
      mined.set(tx.hash, { ...tx, block: blocks.length });
    }
    pool.clear();
    blocks.push(included.map((tx) => tx.hash));
  };
  const blockHash = (number: number) => id(`fake-chain-block-${number}`);
  const block = (tag: unknown) => {
    const number = typeof tag === "string" && tag.startsWith("0x") ? Number(BigInt(tag)) : blocks.length - 1;
    const transactions = blocks[number];
    if (transactions === undefined) return null;
    return {
      number: toQuantity(number), hash: blockHash(number), parentHash: number === 0 ? `0x${"0".repeat(64)}` : blockHash(number - 1),
      timestamp: toQuantity(1_800_000_000 + number * 12), nonce: "0x0000000000000000", difficulty: "0x0", gasLimit: toQuantity(30_000_000),
      gasUsed: toQuantity(transferGas * BigInt(transactions.length)), miner: `0x${"0".repeat(40)}`, extraData: "0x",
      baseFeePerGas: toQuantity(baseFee), transactions,
    };
  };
  const receipt = (hash: unknown) => {
    const tx = typeof hash === "string" ? mined.get(hash.toLowerCase()) : undefined;
    if (tx === undefined) return null;
    const index = blocks[tx.block]?.indexOf(tx.hash) ?? 0;
    return {
      transactionHash: tx.hash, transactionIndex: toQuantity(index), blockHash: blockHash(tx.block), blockNumber: toQuantity(tx.block),
      from: tx.from, to: tx.to, gasUsed: toQuantity(tx.gas), cumulativeGasUsed: toQuantity(tx.gas * BigInt(index + 1)),
      effectiveGasPrice: toQuantity(tx.price), contractAddress: null, logs: [], logsBloom: `0x${"0".repeat(512)}`, status: "0x1", type: "0x2",
    };
  };
  const refusals: string[] = [];
  const refuse = (message: string): Answer => {
    refusals.push(message);
    return { error: { code: -32000, message } };
  };
  const accept = (raw: string): Answer => {
    const tx = Transaction.from(raw);
    const hash = tx.hash;
    if (hash === null || tx.chainId !== chainId || tx.from === null || tx.to === null || tx.maxFeePerGas === null || tx.maxPriorityFeePerGas === null) return refuse("invalid transaction");
    if (pool.has(hash)) return refuse("already known");
    if (tx.nonce < pendingNonce(tx.from)) return refuse("nonce too low");
    if (tx.nonce > pendingNonce(tx.from)) return refuse("nonce too high");
    if (tx.maxFeePerGas < baseFee) return refuse("max fee per gas less than block base fee");
    if (balance(tx.from) < tx.value + tx.gasLimit * tx.maxFeePerGas) return refuse("insufficient funds for gas * price + value");
    const price = baseFee + (tx.maxPriorityFeePerGas < tx.maxFeePerGas - baseFee ? tx.maxPriorityFeePerGas : tx.maxFeePerGas - baseFee);
    const decoded: readonly unknown[] = tx.to.toLowerCase() === token.toLowerCase() ? erc20.decodeFunctionData("transfer", tx.data) : [];
    const payee = decoded[0];
    const units = decoded[1];
    const moved = typeof payee === "string" && typeof units === "bigint" ? { payee, units } : undefined;
    if (moved !== undefined && tokens(tx.from) < moved.units) return refuse("execution reverted");
    pool.set(hash, {
      hash, from: tx.from.toLowerCase(), to: (moved?.payee ?? tx.to).toLowerCase(),
      value: tx.value, price, gas: transferGas, tokens: moved?.units ?? 0n,
    });
    if (state.automine) mine();
    return { result: hash };
  };
  const view = (request: unknown): Answer => {
    const to = typeof request === "object" && request !== null && "to" in request ? String(request.to) : "";
    const data = typeof request === "object" && request !== null && "data" in request ? String(request.data) : "";
    if (to.toLowerCase() !== token.toLowerCase()) return { result: "0x" };
    const method = erc20.getFunction(data.slice(0, 10))?.name;
    if (method === "symbol") return { result: erc20.encodeFunctionResult("symbol", ["TKN"]) };
    if (method === "decimals") return { result: erc20.encodeFunctionResult("decimals", [6]) };
    if (method === "balanceOf") return { result: erc20.encodeFunctionResult("balanceOf", [tokens(String(erc20.decodeFunctionData("balanceOf", data)[0]))]) };
    return { error: { code: 3, message: "execution reverted" } };
  };
  const node = (call: Call): Answer => {
    const [first, second] = call.params;
    switch (call.method) {
      case "eth_chainId": return { result: toQuantity(chainId) };
      case "eth_blockNumber": return { result: toQuantity(blocks.length - 1) };
      case "eth_getBlockByNumber": return { result: block(first) };
      case "eth_getBalance": return { result: toQuantity(balance(String(first))) };
      case "eth_getTransactionCount": return { result: toQuantity(second === "pending" ? pendingNonce(String(first)) : minedNonce(String(first))) };
      case "eth_estimateGas": return { result: toQuantity(transferGas) };
      case "eth_gasPrice": return { result: toQuantity(baseFee + tip) };
      case "eth_maxPriorityFeePerGas": return { result: toQuantity(tip) };
      case "eth_getTransactionReceipt": return { result: receipt(first) };
      case "eth_call": return view(first);
      case "eth_sendRawTransaction": return accept(String(first));
      default: return { error: { code: -32601, message: `the method ${call.method} does not exist` } };
    }
  };
  const relay = (call: Call): Answer | "lost" => {
    if (call.method !== "eth_sendRawTransaction") return node(call);
    state.sent.push(String(call.params[0]));
    switch (state.gateway) {
      case "pass": return node(call);
      case "refused": return { error: { code: -32000, message: "insufficient funds for gas * price + value" } };
      case "lost": node(call); return "lost";
      case "gatewayError": node(call); return { error: { code: -32603, message: "Upstream response timed out" } };
      case "secondCopy": node(call); return node(call);
      case "missingHash": node(call); return {};
      case "nullHash": node(call); return { result: null };
      case "malformedHash": node(call); return { result: "0x1234" };
      case "otherHash": node(call); return { result: `0x${"a".repeat(64)}` };
      case "uppercaseHash": return { result: `0x${String(node(call).result).slice(2).toUpperCase()}` };
    }
  };
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", () => {
      const parsed: unknown = JSON.parse(body);
      const calls = (Array.isArray(parsed) ? parsed : [parsed]) as Call[];
      const replies: object[] = [];
      for (const call of calls) {
        const answer = relay(call);
        if (answer === "lost") {
          response.destroy();
          return;
        }
        replies.push({ jsonrpc: "2.0", id: call.id, ...answer });
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const state: Chain = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    recipient: Wallet.createRandom().address,
    token,
    gateway: "pass",
    automine: true,
    sent: [],
    refusals,
    fund: (address, wei) => { balances.set(address.toLowerCase(), balance(address) + wei); },
    grant: (address, units) => { held.set(address.toLowerCase(), tokens(address) + units); },
    balance,
    tokens,
    landed: (hash) => mined.has(hash.toLowerCase()),
    mine,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
  return state;
}

export interface Scratch {
  readonly directory: string;
  /** @throws {never} */
  sealed(): string;
  /** @throws {never} */
  keepDesk(): void;
  /** @throws {never} */
  restoreDesk(): void;
  /** @throws {never} */
  remove(): void;
}

/** @throws {never} */
export function scratch(): Scratch {
  const directory = mkdtempSync(join(tmpdir(), "eliza-wallet-"));
  const desk = join(directory, "wallet", "state", "requests");
  return {
    directory,
    sealed: () => readFileSync(join(directory, "wallet", "keys.sealed"), "utf8"),
    keepDesk: () => copyFileSync(desk, `${desk}.kept`),
    restoreDesk: () => copyFileSync(`${desk}.kept`, desk),
    remove: () => rmSync(directory, { recursive: true, force: true }),
  };
}
