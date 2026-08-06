/**
 * Clawd Code - Solana blockchain harness mode.
 * Read-first RPC operations plus Z.AI-assisted planning/explanation.
 */

import { listWallets } from '../wallet.js';
import { createZaiClient, ZAI_DEFAULT_MODEL, type ZaiReasoningEffort, type ZaiThinkingType } from '../zai.js';
import {
  canMutateSolana,
  collectSolanaSnapshot,
  formatSol,
  isMutationRpcMethod,
  isSolanaAddress,
  shortAddress,
  SolanaHarnessRpcClient,
  resolveSolanaHarnessConfig,
  type SolanaHarnessConfig,
} from '../solana-harness.js';

interface ChainConfig {
  rpcUrl?: string;
  zaiApiKey?: string;
  zaiBaseUrl?: string;
  zaiThinking?: ZaiThinkingType;
  zaiReasoningEffort?: ZaiReasoningEffort;
  model?: string;
  liveTrading?: boolean;
  operatorConfirmed?: boolean;
}

type AddressResolution = {
  address: string;
  label: string;
};

export class ChainMode {
  private readonly harnessConfig: SolanaHarnessConfig;
  private readonly client: SolanaHarnessRpcClient;

  constructor(private readonly config: ChainConfig = {}) {
    this.harnessConfig = {
      ...resolveSolanaHarnessConfig(process.env),
      ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
      liveTrading: config.liveTrading ?? process.env.LIVE_TRADING === 'true',
      operatorConfirmed: config.operatorConfirmed ?? process.env.OPERATOR_CONFIRMED === 'true',
    };
    this.client = new SolanaHarnessRpcClient(this.harnessConfig);
  }

  async run(args: string[]): Promise<void> {
    const sub = (args[0] ?? 'status').toLowerCase();
    const rest = args.slice(1);

    try {
      switch (sub) {
        case 'status':
        case 'health':
        case 'snapshot':
          await this.showStatus();
          return;
        case 'balance':
        case 'bal':
          await this.showBalance(rest);
          return;
        case 'account':
        case 'acct':
          await this.showAccount(rest);
          return;
        case 'tx':
        case 'transaction':
          await this.showTransaction(rest);
          return;
        case 'sigs':
        case 'signatures':
          await this.showSignatures(rest);
          return;
        case 'program':
          await this.showProgram(rest);
          return;
        case 'token':
          await this.showToken(rest);
          return;
        case 'token-accounts':
        case 'tokens':
          await this.showTokenAccounts(rest);
          return;
        case 'fees':
          await this.showFees(rest);
          return;
        case 'blockhash':
          await this.showBlockhash();
          return;
        case 'airdrop':
        case 'faucet':
          await this.airdrop(rest);
          return;
        case 'simulate':
          await this.simulate(rest);
          return;
        case 'send-raw':
          await this.sendRaw(rest);
          return;
        case 'rpc':
          await this.rawRpc(rest);
          return;
        case 'ask':
        case 'ai':
        case 'plan':
        case 'explain':
          await this.askZai(rest.join(' '));
          return;
        case 'help':
        case '--help':
        case '-h':
          this.printHelp();
          return;
        default:
          await this.askZai(args.join(' '));
      }
    } catch (error) {
      console.error(`[CHAIN] ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async showStatus(): Promise<void> {
    const snapshot = await collectSolanaSnapshot(this.client);
    const blockhash = this.getNested<string>(snapshot.latestBlockhash, ['value', 'blockhash']) ?? 'n/a';
    const version = this.getNested<string>(snapshot.version, ['solana-core']) ?? 'n/a';

    console.log('\nSOLANA HARNESS STATUS');
    console.log(`  cluster     : ${snapshot.cluster}`);
    console.log(`  rpc         : ${snapshot.rpcUrl}`);
    console.log(`  commitment  : ${snapshot.commitment}`);
    console.log(`  read-only   : ${String(snapshot.readOnly)}`);
    console.log(`  mutate gate : ${canMutateSolana(this.harnessConfig) ? 'armed' : 'blocked'}`);
    console.log(`  health      : ${snapshot.health ?? 'unknown'}`);
    console.log(`  version     : ${version}`);
    console.log(`  slot        : ${snapshot.slot ?? 'unknown'}`);
    console.log(`  blockhash   : ${blockhash}`);
  }

  private async showBalance(args: string[]): Promise<void> {
    const target = this.resolveAddress(args[0] ?? 'default');
    const result = await this.client.getBalance(target.address);

    console.log('\nSOLANA BALANCE');
    console.log(`  target      : ${target.label}`);
    console.log(`  address     : ${target.address}`);
    console.log(`  lamports    : ${result.value}`);
    console.log(`  sol         : ${formatSol(result.value)}`);
  }

  private async showAccount(args: string[]): Promise<void> {
    const target = this.resolveAddress(args[0]);
    const encoding = this.flag(args, '--encoding') ?? 'jsonParsed';
    const result = await this.client.getAccountInfo(target.address, encoding);
    const account = result.value;

    console.log('\nSOLANA ACCOUNT');
    console.log(`  address     : ${target.address}`);
    if (!account) {
      console.log('  status      : not found');
      return;
    }
    console.log(`  owner       : ${account.owner}`);
    console.log(`  lamports    : ${account.lamports} (${formatSol(account.lamports)})`);
    console.log(`  executable  : ${account.executable}`);
    console.log(`  rent epoch  : ${account.rentEpoch}`);
    if (account.space !== undefined) console.log(`  space       : ${account.space} bytes`);
    console.log(`  data        : ${this.summarizeData(account.data)}`);
  }

  private async showTransaction(args: string[]): Promise<void> {
    const signature = args[0];
    if (!signature) throw new Error('Usage: clawd-code chain tx <signature>');
    const tx = await this.client.getTransaction(signature);

    console.log('\nSOLANA TRANSACTION');
    console.log(`  signature   : ${signature}`);
    console.log(JSON.stringify(tx, null, 2));
  }

  private async showSignatures(args: string[]): Promise<void> {
    const target = this.resolveAddress(args[0]);
    const limit = this.numberFlag(args, '--limit', 10);
    const signatures = await this.client.getSignaturesForAddress(target.address, limit);

    console.log('\nSOLANA SIGNATURES');
    console.log(`  address     : ${target.address}`);
    console.log(`  limit       : ${limit}`);
    console.log(JSON.stringify(signatures, null, 2));
  }

  private async showProgram(args: string[]): Promise<void> {
    const target = this.resolveAddress(args[0]);
    const account = (await this.client.getAccountInfo(target.address, 'jsonParsed')).value;

    console.log('\nSOLANA PROGRAM');
    console.log(`  program id  : ${target.address}`);
    if (account) {
      console.log(`  owner       : ${account.owner}`);
      console.log(`  executable  : ${account.executable}`);
      console.log(`  lamports    : ${account.lamports} (${formatSol(account.lamports)})`);
    }

    if (!args.includes('--allow-large')) {
      console.log('  accounts    : skipped');
      console.log('  note        : add --allow-large to call getProgramAccounts; large programs can return many accounts.');
      return;
    }

    const accounts = await this.client.getProgramAccounts(target.address);
    console.log(`  accounts    : ${accounts.length}`);
    for (const item of accounts.slice(0, 20)) {
      console.log(`    ${shortAddress(item.pubkey)} lamports=${item.account.lamports} owner=${shortAddress(item.account.owner)}`);
    }
    if (accounts.length > 20) console.log(`    ... ${accounts.length - 20} more`);
  }

  private async showToken(args: string[]): Promise<void> {
    const mint = this.resolveAddress(args[0]);
    const [supply, largest] = await Promise.all([
      this.client.getTokenSupply(mint.address),
      this.client.getTokenLargestAccounts(mint.address),
    ]);

    console.log('\nSOLANA TOKEN');
    console.log(`  mint        : ${mint.address}`);
    console.log('  supply      :');
    console.log(JSON.stringify(supply, null, 2));
    console.log('  largest accounts:');
    console.log(JSON.stringify(largest, null, 2));
  }

  private async showTokenAccounts(args: string[]): Promise<void> {
    const owner = this.resolveAddress(args[0]);
    const mint = this.flag(args, '--mint');
    const programId = this.flag(args, '--program-id');
    const result = await this.client.getTokenAccountsByOwner(owner.address, { mint, programId });

    console.log('\nSOLANA TOKEN ACCOUNTS');
    console.log(`  owner       : ${owner.address}`);
    if (mint) console.log(`  mint        : ${mint}`);
    console.log(JSON.stringify(result, null, 2));
  }

  private async showFees(args: string[]): Promise<void> {
    const addresses = args.filter((arg) => !arg.startsWith('--')).filter(isSolanaAddress);
    const result = await this.client.getRecentPrioritizationFees(addresses);

    console.log('\nSOLANA PRIORITIZATION FEES');
    if (addresses.length) console.log(`  accounts    : ${addresses.join(', ')}`);
    console.log(JSON.stringify(result, null, 2));
  }

  private async showBlockhash(): Promise<void> {
    const result = await this.client.getLatestBlockhash();
    console.log('\nSOLANA LATEST BLOCKHASH');
    console.log(JSON.stringify(result, null, 2));
  }

  private async airdrop(args: string[]): Promise<void> {
    const target = this.resolveAddress(args[0]);
    const sol = Number(args[1] ?? '1');
    if (!Number.isFinite(sol) || sol <= 0) throw new Error('Usage: clawd-code chain airdrop <address|wallet> <sol>');
    const signature = await this.client.requestAirdrop(target.address, sol);

    console.log('\nSOLANA AIRDROP');
    console.log(`  cluster     : ${this.harnessConfig.cluster}`);
    console.log(`  address     : ${target.address}`);
    console.log(`  amount      : ${sol} SOL`);
    console.log(`  signature   : ${signature}`);
  }

  private async simulate(args: string[]): Promise<void> {
    const base64Tx = args[0];
    if (!base64Tx) throw new Error('Usage: clawd-code chain simulate <base64-transaction>');
    const result = await this.client.simulateTransaction(base64Tx);
    console.log('\nSOLANA SIMULATION');
    console.log(JSON.stringify(result, null, 2));
  }

  private async sendRaw(args: string[]): Promise<void> {
    const base64Tx = args[0];
    if (!base64Tx) throw new Error('Usage: clawd-code chain send-raw <base64-transaction>');
    const signature = await this.client.sendRawTransaction(base64Tx);
    console.log('\nSOLANA SEND RAW');
    console.log(`  signature   : ${signature}`);
  }

  private async rawRpc(args: string[]): Promise<void> {
    const method = args[0];
    if (!method) throw new Error('Usage: clawd-code chain rpc <method> [jsonParamsArray]');
    if (isMutationRpcMethod(method) && !canMutateSolana(this.harnessConfig)) {
      throw new Error(`${method} is mutation RPC and the harness mutation gate is blocked.`);
    }
    if (!this.harnessConfig.allowUnsafeRpc && !this.isKnownReadRpc(method) && !isMutationRpcMethod(method)) {
      throw new Error(`Unknown RPC method ${method}. Set SOLANA_HARNESS_ALLOW_UNSAFE_RPC=true to allow arbitrary methods.`);
    }
    const params = this.parseJsonParams(args.slice(1).join(' '));
    const result = await this.client.request(method, params);
    console.log('\nSOLANA RAW RPC');
    console.log(JSON.stringify(result, null, 2));
  }

  private async askZai(prompt: string): Promise<void> {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) {
      this.printHelp();
      return;
    }

    const snapshot = await collectSolanaSnapshot(this.client);
    const client = createZaiClient(this.config.zaiApiKey || process.env.ZAI_API_KEY, this.config.zaiBaseUrl);
    if (!client) {
      console.log('\nSOLANA HARNESS PLAN');
      console.log('  ZAI_API_KEY is not set, so this is deterministic fallback guidance.');
      console.log(`  Intent: ${cleanPrompt}`);
      console.log('  Use: chain status | balance <wallet> | account <address> | tx <signature> | token <mint> | fees');
      console.log('  For AI planning, set ZAI_API_KEY and rerun: clawd-code chain ask "<intent>"');
      return;
    }

    const system = [
      'You are Clawd Solana Blockchain Harness.',
      'Turn operator intent into safe Solana RPC inspection plans and concise explanations.',
      'Never ask for private keys. Never recommend live sendTransaction unless live gates are explicitly armed.',
      'Prefer exact clawd-code chain commands.',
      'Available commands: status, balance, account, tx, signatures, program, token, token-accounts, fees, blockhash, airdrop on devnet/local, rpc, simulate, send-raw gated.',
    ].join('\n');

    const response = await client.chat({
      model: this.config.model?.startsWith('glm-') ? this.config.model : ZAI_DEFAULT_MODEL,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            `Intent: ${cleanPrompt}`,
            `Harness snapshot: ${JSON.stringify(snapshot)}`,
            `Mutation gate armed: ${canMutateSolana(this.harnessConfig)}`,
          ].join('\n\n'),
        },
      ],
      maxTokens: 2048,
      temperature: 0.2,
      thinking: this.config.zaiThinking ?? 'enabled',
      reasoningEffort: this.config.zaiReasoningEffort ?? 'medium',
    });

    if (response.reasoningContent && process.env.ZAI_SHOW_THINKING === 'true') {
      console.log(`\nZAI REASONING\n${response.reasoningContent}`);
    }
    console.log('\nSOLANA HARNESS AI');
    console.log(response.content || '(empty response)');
  }

  private resolveAddress(input: string | undefined): AddressResolution {
    if (isSolanaAddress(input)) return { address: input as string, label: input as string };

    const name = input || 'default';
    const wallet = listWallets().find((item) => item.name === name);
    if (wallet) return { address: wallet.publicKey, label: `wallet:${wallet.name}` };

    throw new Error(`Expected a Solana address or local wallet name, got "${name}".`);
  }

  private flag(args: string[], name: string): string | undefined {
    const prefixed = `${name}=`;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === name && args[i + 1]) return args[i + 1];
      if (args[i].startsWith(prefixed)) return args[i].slice(prefixed.length);
    }
    return undefined;
  }

  private numberFlag(args: string[], name: string, fallback: number): number {
    const raw = this.flag(args, name);
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  }

  private parseJsonParams(raw: string): unknown[] {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  private summarizeData(data: unknown): string {
    if (Array.isArray(data) && typeof data[0] === 'string') {
      const bytes = Buffer.from(data[0], 'base64').length;
      return `base64 (${bytes} bytes)`;
    }
    const text = JSON.stringify(data);
    return text.length > 240 ? `${text.slice(0, 240)}...` : text;
  }

  private getNested<T>(value: unknown, path: string[]): T | undefined {
    let current = value as Record<string, unknown> | undefined;
    for (const key of path) {
      if (!current || typeof current !== 'object') return undefined;
      current = current[key] as Record<string, unknown> | undefined;
    }
    return current as T | undefined;
  }

  private isKnownReadRpc(method: string): boolean {
    return [
      'getAccountInfo',
      'getBalance',
      'getBlock',
      'getBlockHeight',
      'getBlockProduction',
      'getBlockTime',
      'getBlocks',
      'getClusterNodes',
      'getEpochInfo',
      'getEpochSchedule',
      'getFeeForMessage',
      'getFirstAvailableBlock',
      'getGenesisHash',
      'getHealth',
      'getHighestSnapshotSlot',
      'getIdentity',
      'getInflationGovernor',
      'getInflationRate',
      'getLargestAccounts',
      'getLatestBlockhash',
      'getLeaderSchedule',
      'getMinimumBalanceForRentExemption',
      'getMultipleAccounts',
      'getProgramAccounts',
      'getRecentPerformanceSamples',
      'getRecentPrioritizationFees',
      'getSignaturesForAddress',
      'getSlot',
      'getSlotLeader',
      'getSupply',
      'getTokenAccountBalance',
      'getTokenAccountsByDelegate',
      'getTokenAccountsByOwner',
      'getTokenLargestAccounts',
      'getTokenSupply',
      'getTransaction',
      'getTransactionCount',
      'getVersion',
      'getVoteAccounts',
      'isBlockhashValid',
      'simulateTransaction',
    ].includes(method);
  }

  private printHelp(): void {
    console.log(`
SOLANA BLOCKCHAIN HARNESS
  clawd-code chain status
  clawd-code chain balance <address|wallet>
  clawd-code chain account <address|wallet> [--encoding jsonParsed|base64]
  clawd-code chain tx <signature>
  clawd-code chain signatures <address|wallet> [--limit 10]
  clawd-code chain program <programId> [--allow-large]
  clawd-code chain token <mint>
  clawd-code chain token-accounts <owner> [--mint <mint>]
  clawd-code chain fees [account...]
  clawd-code chain blockhash
  clawd-code chain airdrop <address|wallet> <sol>      devnet/testnet/local only
  clawd-code chain simulate <base64-transaction>
  clawd-code chain send-raw <base64-transaction>       gated
  clawd-code chain rpc <method> '[params]'
  clawd-code chain ask "what should I inspect?"

ENV:
  SOLANA_RPC_URL, HELIUS_RPC_URL, HELIUS_API_KEY
  SOLANA_CLUSTER, SOLANA_COMMITMENT
  SOLANA_HARNESS_READONLY=false + LIVE_TRADING=true + OPERATOR_CONFIRMED=true to permit send-raw
  ZAI_API_KEY for AI planning and explanation
`);
  }
}
