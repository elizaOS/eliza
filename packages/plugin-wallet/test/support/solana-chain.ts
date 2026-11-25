// spec/wallet/index.md, "Story: Recover the real outcome of an on-chain operation"; spec/wallet/index.md, "Story: Inspect wallet holdings and venue quotes before making changes"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { getBase58Decoder } from "@solana/codecs"
import { Keypair, Message, PublicKey, SystemInstruction, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js"

export type SolanaGateway = "pass" | "lost" | "refused"
export type TokenProgram = "token" | "token2022"

export interface SolanaWallet { readonly seed: Uint8Array; readonly address: string }

export interface SolanaChain {
  readonly url: string
  genesisHash: string
  gateway: SolanaGateway
  readonly sent: string[]
  /** @throws {never} */
  wallet(lamports: bigint): SolanaWallet
  /** @throws {never} */
  mint(program: TokenProgram, decimals: number): string
  /** @throws {never} */
  tokenAccount(owner: string, mint: string, amount: bigint, associated?: boolean): string
  /** @throws {never} */
  balance(address: string): bigint
  /** @throws {never} */
  tokens(owner: string, mint: string): bigint
  /** @throws {never} */
  mine(): void
  /** @throws {never} */
  finalize(): void
  close(): Promise<void>
}

interface Call { readonly id: unknown; readonly method: string; readonly params: readonly unknown[] }
interface Answer { readonly result?: unknown; readonly error?: { readonly code: number; readonly message: string } }
interface Mint { readonly program: PublicKey; readonly decimals: number }
interface TokenAccount { readonly program: PublicKey; readonly mint: string; readonly owner: string; amount: bigint }
type Transfer =
  | { readonly kind: "native"; readonly from: string; readonly to: string; readonly lamports: bigint }
  | { readonly kind: "token"; readonly program: PublicKey; readonly source: string; readonly mint: string; readonly destination: string; readonly owner: string; readonly amount: bigint; readonly decimals: number }
interface Pooled { readonly payer: string; readonly fee: bigint; readonly transfer: Transfer }
interface Landed { readonly err: unknown; finalized: boolean }

const signatureFee = 5000n
const programs: Record<TokenProgram, PublicKey> = {
  token: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  token2022: new PublicKey("TokenzQdBNbLqP5VYfdjZXMUrcZ3fMRjFh8uDxWXVkd"),
}
const associatedTokenProgram = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
const transferChecked = 12
const fresh = () => Keypair.generate().publicKey.toBase58()

/** @throws {never} */
export async function startSolanaChain(): Promise<SolanaChain> {
  const balances = new Map<string, bigint>()
  const mints = new Map<string, Mint>()
  const tokenAccounts = new Map<string, TokenAccount>()
  const pool = new Map<string, Pooled>()
  const landed = new Map<string, Landed>()
  const blockhash = fresh()
  const balance = (address: string) => balances.get(address) ?? 0n
  const context = { slot: 1 }

  const decoded = (instruction: TransactionInstruction): Transfer | undefined => {
    if (instruction.programId.equals(SystemProgram.programId)) {
      const { fromPubkey, toPubkey, lamports } = SystemInstruction.decodeTransfer(instruction)
      return { kind: "native", from: fromPubkey.toBase58(), to: toPubkey.toBase58(), lamports }
    }
    const [source, mint, destination, owner] = instruction.keys
    const { data } = instruction
    if (source === undefined || mint === undefined || destination === undefined || owner === undefined || instruction.keys.length !== 4) return undefined
    if (data.length !== 10 || data[0] !== transferChecked || !source.isWritable || mint.isWritable || !destination.isWritable || !owner.isSigner) return undefined
    return {
      kind: "token", program: instruction.programId, source: source.pubkey.toBase58(), mint: mint.pubkey.toBase58(),
      destination: destination.pubkey.toBase58(), owner: owner.pubkey.toBase58(), amount: data.readBigUInt64LE(1), decimals: data.readUInt8(9),
    }
  }
  const refusal = ({ payer, fee, transfer }: Pooled): string | undefined => {
    if (transfer.kind === "native") return balance(transfer.from) < transfer.lamports + (transfer.from === payer ? fee : 0n) ? "insufficient lamports" : undefined
    const mint = mints.get(transfer.mint)
    const source = tokenAccounts.get(transfer.source)
    const destination = tokenAccounts.get(transfer.destination)
    if (mint === undefined || !mint.program.equals(transfer.program)) return "incorrect program id for instruction"
    if (source === undefined || destination === undefined) return "invalid account data for instruction"
    if (!source.program.equals(transfer.program) || !destination.program.equals(transfer.program)) return "incorrect program id for instruction"
    if (source.mint !== transfer.mint || destination.mint !== transfer.mint || mint.decimals !== transfer.decimals) return "custom program error: 0x3"
    if (source.owner !== transfer.owner) return "custom program error: 0x4"
    return source.amount < transfer.amount ? "custom program error: 0x1" : undefined
  }
  const execute = ({ transfer }: Pooled) => {
    if (transfer.kind === "native") {
      balances.set(transfer.from, balance(transfer.from) - transfer.lamports)
      balances.set(transfer.to, balance(transfer.to) + transfer.lamports)
      return
    }
    const source = tokenAccounts.get(transfer.source)
    const destination = tokenAccounts.get(transfer.destination)
    if (source === undefined || destination === undefined) return
    source.amount -= transfer.amount
    destination.amount += transfer.amount
  }
  const mine = () => {
    for (const [signature, pooled] of pool) {
      balances.set(pooled.payer, balance(pooled.payer) - pooled.fee)
      const failure = refusal({ ...pooled, fee: 0n })
      if (failure === undefined) execute(pooled)
      landed.set(signature, { err: failure === undefined ? null : { InstructionError: [0, failure] }, finalized: false })
    }
    pool.clear()
  }
  const simulationFailed = (message: string): Answer => ({ error: { code: -32002, message: `Transaction simulation failed: ${message}` } })
  const accept = (wire: unknown): Answer => {
    const transaction = Transaction.from(Buffer.from(String(wire), "base64"))
    const [instruction] = transaction.instructions
    const { signature, feePayer } = transaction
    if (signature === null || feePayer === undefined || !transaction.verifySignatures()) return { error: { code: -32003, message: "Transaction signature verification failure" } }
    const id = getBase58Decoder().decode(signature)
    if (landed.has(id)) return simulationFailed("This transaction has already been processed")
    if (pool.has(id)) return { result: id }
    if (transaction.recentBlockhash !== blockhash) return simulationFailed("Blockhash not found")
    const transfer = instruction === undefined || transaction.instructions.length !== 1 ? undefined : decoded(instruction)
    if (transfer === undefined) return simulationFailed("Error processing Instruction 0: invalid instruction data")
    const pooled = { payer: feePayer.toBase58(), fee: signatureFee * BigInt(transaction.signatures.length), transfer }
    if (balance(pooled.payer) < pooled.fee) return simulationFailed("Attempt to debit an account but found no record of a prior credit.")
    const failure = refusal(pooled)
    if (failure !== undefined) return simulationFailed(`Error processing Instruction 0: ${failure}`)
    pool.set(id, pooled)
    return { result: id }
  }
  const fee = (encoded: unknown) => {
    const message = Message.from(Buffer.from(String(encoded), "base64"))
    return message.recentBlockhash === blockhash ? Number(signatureFee) * message.header.numRequiredSignatures : null
  }
  const parsedTokenAccount = (account: TokenAccount) => ({
    data: {
      program: account.program.equals(programs.token) ? "spl-token" : "spl-token-2022", space: 165,
      parsed: { type: "account", info: {
        isNative: false, mint: account.mint, owner: account.owner, state: "initialized",
        tokenAmount: { amount: String(account.amount), decimals: mints.get(account.mint)?.decimals ?? 0 },
      } },
    },
    executable: false, lamports: 2039280, owner: account.program.toBase58(), space: 165,
  })
  const accountInfo = (address: string) => {
    const mint = mints.get(address)
    const tokenAccount = tokenAccounts.get(address)
    if (mint !== undefined) {
      return {
        data: { program: mint.program.equals(programs.token) ? "spl-token" : "spl-token-2022", space: 82, parsed: { type: "mint", info: { decimals: mint.decimals, isInitialized: true, mintAuthority: null, freezeAuthority: null } } },
        executable: false, lamports: 1461600, owner: mint.program.toBase58(), space: 82,
      }
    }
    if (tokenAccount !== undefined) return parsedTokenAccount(tokenAccount)
    return balances.has(address) ? { data: ["", "base64"], executable: false, lamports: Number(balance(address)), owner: SystemProgram.programId.toBase58(), space: 0 } : null
  }
  const owned = (owner: unknown, filter: unknown) => [...tokenAccounts]
    .filter(([, account]) => account.owner === owner && typeof filter === "object" && filter !== null && "programId" in filter && filter.programId === account.program.toBase58())
    .map(([pubkey, account]) => ({ pubkey, account: parsedTokenAccount(account) }))
  const status = (signature: unknown) => {
    const found = typeof signature === "string" ? landed.get(signature) : undefined
    if (found === undefined) return null
    return {
      slot: context.slot, confirmations: found.finalized ? null : 1, err: found.err,
      status: found.err === null ? { Ok: null } : { Err: found.err }, confirmationStatus: found.finalized ? "finalized" : "confirmed",
    }
  }
  const node = (call: Call): Answer => {
    const [first, second] = call.params
    switch (call.method) {
      case "getGenesisHash": return { result: state.genesisHash }
      case "getBalance": return { result: { context, value: Number(balance(String(first))) } }
      case "getLatestBlockhash": return { result: { context, value: { blockhash, lastValidBlockHeight: 150 } } }
      case "getFeeForMessage": return { result: { context, value: fee(first) } }
      case "getAccountInfo": return { result: { context, value: accountInfo(String(first)) } }
      case "getTokenAccountsByOwner": return { result: { context, value: owned(first, second) } }
      case "getSignatureStatuses": return { result: { context, value: (Array.isArray(first) ? first : []).map(status) } }
      case "sendTransaction": return accept(first)
      default: return { error: { code: -32601, message: "Method not found" } }
    }
  }
  const relay = (call: Call): Answer | "lost" => {
    if (call.method !== "sendTransaction") return node(call)
    state.sent.push(String(call.params[0]))
    switch (state.gateway) {
      case "pass": return node(call)
      case "refused": return { error: { code: -32005, message: "Node is behind by 400 slots" } }
      case "lost": node(call); return "lost"
    }
  }
  const server: Server = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8") })
    request.on("end", () => {
      const call = JSON.parse(body) as Call
      const answer = relay(call)
      if (answer === "lost") {
        response.destroy()
        return
      }
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, ...answer }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const state: SolanaChain = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    genesisHash: fresh(),
    gateway: "pass",
    sent: [],
    wallet: (lamports) => {
      const keys = Keypair.generate()
      balances.set(keys.publicKey.toBase58(), lamports)
      return { seed: keys.secretKey.slice(0, 32), address: keys.publicKey.toBase58() }
    },
    mint: (program, decimals) => {
      const address = fresh()
      mints.set(address, { program: programs[program], decimals })
      return address
    },
    tokenAccount: (owner, mint, amount, associated = true) => {
      const program = mints.get(mint)?.program ?? programs.token
      const seeds = [new PublicKey(owner), program, new PublicKey(mint)].map((key) => key.toBuffer())
      const address = associated ? PublicKey.findProgramAddressSync(seeds, associatedTokenProgram)[0].toBase58() : fresh()
      tokenAccounts.set(address, { program, mint, owner, amount })
      return address
    },
    balance,
    tokens: (owner, mint) => [...tokenAccounts.values()].filter((account) => account.owner === owner && account.mint === mint).reduce((sum, account) => sum + account.amount, 0n),
    mine,
    finalize: () => {
      for (const transaction of landed.values()) transaction.finalized = true
    },
    close: () => {
      server.closeAllConnections()
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
  return state
}
