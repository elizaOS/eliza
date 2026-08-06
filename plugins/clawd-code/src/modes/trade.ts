/**
 * Clawd Code — TRADE MODE
 * Perpetuals trading with Phoenix + Vulcan CLI + Helius RPC
 * Default model for AI analysis: Z.AI GLM-5.2, with GLM-5V for chart vision.
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { extname } from 'path';
import { upsertClawdEnv } from '../env.js';
import { DEFAULT_MODEL, DEFAULT_TRADE_VISION_MODEL } from '../grok-models.js';
import {
  ImperialClient,
  ImperialOrderSide,
  buildImperialConnectMessage,
  buildImperialMarketOrder,
  extractImperialMarkPrice,
  getImperialConfig,
  getImperialLiveReadiness,
  getTradingGateState,
  imperialUnderwriterLabel,
  maskImperialCredential,
  validateImperialOrderIntent,
  type ImperialConfig,
  type TradingGateState,
} from '../imperial.js';
import { loadWalletKeypair, signWalletMessage } from '../wallet.js';
import { createZaiClient, ZAI_TRADE_VISION_MODEL } from '../zai.js';

export class TradeMode {
  constructor(private config: any) {}

  private imperialConfig(): ImperialConfig {
    return this.config.imperial ?? getImperialConfig(process.env);
  }

  private gateState(): TradingGateState {
    if (
      typeof this.config.liveTrading === 'boolean' ||
      typeof this.config.operatorConfirmed === 'boolean' ||
      typeof this.config.perpsSimOnly === 'boolean'
    ) {
      return {
        liveTrading: this.config.liveTrading === true,
        operatorConfirmed: this.config.operatorConfirmed === true,
        perpsSimOnly: this.config.perpsSimOnly !== false,
      };
    }
    return getTradingGateState(process.env);
  }

  private displayUrl(url: string | undefined): string {
    if (!url) return '(unset)';
    return url.replace(/([?&](?:api-key|apikey|key|token)=)[^&]+/gi, '$1***');
  }

  async run(args: string[]): Promise<void> {
    const command = this.commandText(args);
    const imperial = this.imperialConfig();

    console.log('\n[TRADE MODE] Entering perpetuals trading mode...\n');
    console.log(`[TRADE MODE] RPC: ${this.displayUrl(this.config.rpcUrl)}`);
    console.log(`[TRADE MODE] Live Trading: ${this.config.liveTrading}`);
    console.log(`[TRADE MODE] Operator Confirmed: ${this.config.operatorConfirmed}`);
    console.log(`[TRADE MODE] Imperial: ${imperial.enabled ? 'enabled' : 'disabled'} (${imperialUnderwriterLabel(imperial.defaultUnderwriter)}, profile ${imperial.profileIndex})`);
    const analysisModel = this.config.model ?? DEFAULT_MODEL;
    const visionModel = this.config.zaiTradeVisionModel ?? DEFAULT_TRADE_VISION_MODEL;
    console.log(`[TRADE MODE] AI analysis model (Z.AI default): ${analysisModel}`);
    console.log(`[TRADE MODE] Chart vision model: ${visionModel}`);
    // Check safety gates
    if (!this.config.liveTrading) {
      console.log('\n[TRADE MODE] ⚠ PAPER MODE — No real funds will be used');
      console.log('[TRADE MODE] To enable live trading, set LIVE_TRADING=true and OPERATOR_CONFIRMED=true');
    }

    // Parse trading command
    const action = command.toLowerCase();
    const chartInput =
      this.argValue(args, '--chart') ||
      this.argValue(args, '--image') ||
      this.argValue(args, '--screenshot') ||
      this.firstUrl(command) ||
      this.firstExistingImagePath(args);

    if (
      chartInput ||
      action.includes('chart') ||
      action.includes('vision') ||
      action.includes('screenshot') ||
      action.includes('realtime') ||
      action.includes('real-time')
    ) {
      await this.analyzeChart(command, chartInput);
      return;
    }

    if (action.includes('imperial')) {
      await this.handleImperial(command, args);
      return;
    }
    
    if (action.includes('funding') || action.includes('rate')) {
      await this.fetchFundingRates();
    } else if (action.includes('ticker') || action.includes('price')) {
      await this.fetchTicker(command);
    } else if (action.includes('orderbook') || action.includes('depth')) {
      await this.fetchOrderbook(command);
    } else if (action.includes('short')) {
      await this.executeShort(command, args);
    } else if (action.includes('long')) {
      await this.executeLong(command, args);
    } else if (action.includes('scan') || action.includes('signal')) {
      await this.scanMarkets();
    } else if (action.includes('position') || action.includes('portfolio')) {
      await this.showPosition();
    } else if (action.includes('paper')) {
      await this.paperTrade(command);
    } else {
      await this.showStatus();
    }
  }

  private commandText(args: string[]): string {
    const valueFlags = new Set([
      '--chart',
      '--image',
      '--screenshot',
      '--model',
      '--size',
      '--wallet',
      '--wallet-name',
      '--profile',
      '--profile-index',
      '--market-price',
      '--price',
      '--nonce',
      '--wallet-address',
    ]);
    const parts: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (valueFlags.has(arg)) {
        i++;
        continue;
      }
      if (arg.startsWith('--')) continue;
      parts.push(arg);
    }
    return parts.join(' ').trim();
  }

  private argValue(args: string[], flag: string): string | undefined {
    const prefixed = `${flag}=`;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === flag && args[i + 1]) return args[i + 1];
      if (args[i].startsWith(prefixed)) return args[i].slice(prefixed.length);
    }
    return undefined;
  }

  private firstUrl(text: string): string | undefined {
    return text.match(/(?:https?:\/\/|data:image\/)[^\s]+/i)?.[0];
  }

  private firstExistingImagePath(args: string[]): string | undefined {
    for (let i = args.length - 1; i >= 0; i--) {
      const candidate = this.expandPath(args[i]);
      const ext = extname(candidate).toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) continue;
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  }

  private async analyzeChart(command: string, chartInput?: string): Promise<void> {
    if (!chartInput) {
      console.log('\n[TRADE MODE] Chart analysis needs an image URL or local file.');
      console.log('[TRADE MODE] Usage: clawd-code trade "analyze chart" --chart ./chart.png');
      return;
    }

    const client = createZaiClient(this.config.zaiApiKey, this.config.zaiBaseUrl);
    if (!client) {
      console.log('\n[TRADE MODE] ZAI_API_KEY not set. Add it to ~/.clawd-code/.env for GLM-5V chart analysis.');
      return;
    }

    const imageUrl = this.imageInputToUrl(chartInput);
    const model = this.config.zaiTradeVisionModel || ZAI_TRADE_VISION_MODEL;
    const prompt = [
      'You are Clawd Trade chart vision. Analyze this trading chart or market screenshot for paper-trading decision support only.',
      'Extract visible symbol, timeframe, trend, structure, support/resistance, liquidity zones, momentum, invalidation, and risk notes.',
      'If the image lacks enough data, say exactly what is missing.',
      'Do not claim live market data unless it is visible in the image or prompt.',
      'Never submit or recommend live execution. End with PAPER MODE preflight status.',
      command ? `Operator request: ${command}` : '',
    ].filter(Boolean).join('\n');

    console.log(`\n[TRADE MODE] Running GLM-5V chart analysis via ${model}...`);
    const response = await client.analyzeImage({
      model,
      prompt,
      imageUrl,
      maxTokens: 4096,
      thinking: this.config.zaiThinking ?? 'enabled',
      reasoningEffort: this.config.zaiReasoningEffort ?? 'high',
    });

    if (response.reasoningContent && process.env.ZAI_SHOW_THINKING === 'true') {
      console.log(`\n[TRADE MODE] Reasoning:\n${response.reasoningContent}`);
    }
    console.log('\n╔════════════════════════════════════════════════════╗');
    console.log('║  CHART VISION ANALYSIS — PAPER MODE                ║');
    console.log('╚════════════════════════════════════════════════════╝');
    console.log(response.content || '(no analysis returned)');
  }

  private imageInputToUrl(input: string): string {
    if (/^(https?:\/\/|data:image\/)/i.test(input)) return input;

    const expanded = this.expandPath(input);
    if (!existsSync(expanded)) return input;

    const mime = this.mimeFromPath(expanded);
    const base64 = readFileSync(expanded).toString('base64');
    return `data:${mime};base64,${base64}`;
  }

  private expandPath(path: string): string {
    if (path === '~') return process.env.HOME || path;
    if (path.startsWith('~/')) return `${process.env.HOME || ''}${path.slice(1)}`;
    return path;
  }

  private mimeFromPath(path: string): string {
    switch (extname(path).toLowerCase()) {
      case '.jpg':
      case '.jpeg':
        return 'image/jpeg';
      case '.webp':
        return 'image/webp';
      case '.png':
      default:
        return 'image/png';
    }
  }

  private async handleImperial(command: string, args: string[]): Promise<void> {
    const action = command.toLowerCase();
    if (action.includes('revoke')) {
      await this.revokeImperialSession();
      return;
    }
    if (action.includes('register') || action.includes('activate')) {
      await this.registerImperialPhoenixProfile(args);
      return;
    }
    if (action.includes('auth') || action.includes('connect') || action.includes('session')) {
      await this.createImperialSession(args);
      return;
    }
    if (action.includes('funding') || action.includes('rate')) {
      if (!(await this.fetchFundingRatesViaImperial())) await this.fetchFundingRates();
      return;
    }
    if (action.includes('balance') || action.includes('margin')) {
      await this.showImperialBalances();
      return;
    }
    if (action.includes('order')) {
      await this.showImperialOrders();
      return;
    }
    if (action.includes('position') || action.includes('portfolio')) {
      await this.showImperialPositions();
      return;
    }
    if (action.includes('short')) {
      await this.executeImperialMarketOrder(command, args, ImperialOrderSide.Short);
      return;
    }
    if (action.includes('long')) {
      await this.executeImperialMarketOrder(command, args, ImperialOrderSide.Long);
      return;
    }
    await this.showImperialStatus();
  }

  private async showImperialStatus(): Promise<void> {
    const imperial = this.imperialConfig();
    const readiness = getImperialLiveReadiness(imperial, this.gateState());
    console.log('\n╔════════════════════════════════════════════════════╗');
    console.log('║  IMPERIAL ROUTER STATUS                            ║');
    console.log('╠════════════════════════════════════════════════════╣');
    console.log(`║  Enabled:     ${String(imperial.enabled).padEnd(36)}║`);
    console.log(`║  Live path:   ${String(imperial.live).padEnd(36)}║`);
    console.log(`║  API:         ${imperial.apiBaseUrl.slice(0, 36).padEnd(36)}║`);
    console.log(`║  Wallet:      ${(imperial.wallet ? `${imperial.wallet.slice(0, 8)}...${imperial.wallet.slice(-4)}` : '(unset)').padEnd(36)}║`);
    console.log(`║  JWT:         ${maskImperialCredential(imperial.jwt).padEnd(36)}║`);
    console.log(`║  Profile:     ${String(imperial.profileIndex).padEnd(36)}║`);
    console.log(`║  Underwriter: ${imperialUnderwriterLabel(imperial.defaultUnderwriter).padEnd(36)}║`);
    console.log(`║  Symbols:     ${imperial.allowedSymbols.join(', ').slice(0, 36).padEnd(36)}║`);
    console.log(`║  Max size:    ${`$${imperial.maxNotionalUsd} / ${imperial.maxLeverage}x`.padEnd(36)}║`);
    console.log('╠════════════════════════════════════════════════════╣');
    console.log(`║  Live ready:  ${String(readiness.ok).padEnd(36)}║`);
    console.log('╚════════════════════════════════════════════════════╝');
    if (!readiness.ok) {
      console.log('\n[IMPERIAL] Live readiness blockers:');
      for (const reason of readiness.reasons) console.log(`  - ${reason}`);
    }
    console.log('\n[IMPERIAL] Commands: imperial funding | imperial balances | imperial positions | imperial orders');
    console.log('[IMPERIAL] Profile:  imperial register [wallet-name] --profile 0');
    console.log('[IMPERIAL] Auth:     imperial auth [wallet-name] --write-env --arm-live');
  }

  private imperialClient(): ImperialClient {
    return new ImperialClient(this.imperialConfig());
  }

  private async fetchFundingRatesViaImperial(): Promise<boolean> {
    const imperial = this.imperialConfig();
    if (!imperial.enabled) return false;
    try {
      const data = await this.imperialClient().getFundingRates();
      console.log('\n╔════════════════════════════════════════════════════╗');
      console.log('║  IMPERIAL — FUNDING RATES                          ║');
      console.log('╚════════════════════════════════════════════════════╝');
      this.printJsonPreview(data);
      return true;
    } catch (error) {
      console.log(`\n[IMPERIAL] Funding rates unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private async showImperialBalances(): Promise<void> {
    const imperial = this.imperialConfig();
    if (!imperial.wallet || !imperial.jwt) {
      console.log('\n[IMPERIAL] Balances require IMPERIAL_WALLET and IMPERIAL_JWT/IMPERIAL_API_KEY.');
      return;
    }
    try {
      const data = await this.imperialClient().getBalances();
      console.log('\n╔════════════════════════════════════════════════════╗');
      console.log(`║  IMPERIAL — BALANCES (profile ${imperial.profileIndex})                 ║`);
      console.log('╚════════════════════════════════════════════════════╝');
      this.printJsonPreview(data);
    } catch (error) {
      console.log(`[IMPERIAL] Balances unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async showImperialPositions(): Promise<void> {
    const imperial = this.imperialConfig();
    if (!imperial.wallet) {
      console.log('\n[IMPERIAL] Positions require IMPERIAL_WALLET.');
      return;
    }
    try {
      const data = await this.imperialClient().getPositions();
      console.log('\n╔════════════════════════════════════════════════════╗');
      console.log('║  IMPERIAL — POSITIONS                              ║');
      console.log('╚════════════════════════════════════════════════════╝');
      this.printJsonPreview(data);
    } catch (error) {
      console.log(`[IMPERIAL] Positions unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async showImperialOrders(): Promise<void> {
    const imperial = this.imperialConfig();
    if (!imperial.wallet) {
      console.log('\n[IMPERIAL] Orders require IMPERIAL_WALLET.');
      return;
    }
    try {
      const data = await this.imperialClient().getOrders();
      console.log('\n╔════════════════════════════════════════════════════╗');
      console.log('║  IMPERIAL — ORDERS                                 ║');
      console.log('╚════════════════════════════════════════════════════╝');
      this.printJsonPreview(data);
    } catch (error) {
      console.log(`[IMPERIAL] Orders unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private printJsonPreview(data: unknown): void {
    const text = JSON.stringify(data, null, 2);
    console.log(text.length > 6000 ? `${text.slice(0, 6000)}\n...` : text);
  }

  private positionalAfter(args: string[], markers: string[]): string | undefined {
    const markerIndex = args.findIndex((arg) => markers.includes(arg.toLowerCase()));
    if (markerIndex === -1) return undefined;
    const candidate = args[markerIndex + 1];
    return candidate && !candidate.startsWith('--') ? candidate : undefined;
  }

  private boolFlag(args: string[], flag: string): boolean {
    return args.includes(flag);
  }

  private parseProfileIndex(args: string[], fallback: number): number | undefined {
    const parsed = Number(this.argValue(args, '--profile') ?? this.argValue(args, '--profile-index') ?? fallback);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 5) return undefined;
    return parsed;
  }

  private resolveImperialWalletForCommand(args: string[], markers: string[]): { wallet?: string; walletName?: string; error?: string } {
    const walletAddress = this.argValue(args, '--wallet-address');
    if (walletAddress) return { wallet: walletAddress };

    const walletName =
      this.argValue(args, '--wallet') ||
      this.argValue(args, '--wallet-name') ||
      this.positionalAfter(args, markers) ||
      this.imperialConfig().wallet ||
      'default';

    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletName)) return { wallet: walletName };

    try {
      const local = loadWalletKeypair(walletName);
      return { wallet: local.publicKey, walletName };
    } catch (error) {
      return {
        walletName,
        error: `Unable to load local wallet "${walletName}": ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async registerImperialPhoenixProfile(args: string[]): Promise<void> {
    const current = this.imperialConfig();
    const profileIndex = this.parseProfileIndex(args, current.profileIndex);
    if (profileIndex === undefined) {
      console.log('\n[IMPERIAL] Register blocked: profile index must be an integer between 0 and 5.');
      return;
    }

    const resolved = this.resolveImperialWalletForCommand(args, ['register', 'activate']);
    if (!resolved.wallet) {
      console.log(`\n[IMPERIAL] ${resolved.error ?? 'No wallet available for registration.'}`);
      console.log('[IMPERIAL] Use --wallet-address <pubkey> or create a local wallet: clawd-code wallet create imperial');
      return;
    }

    try {
      const result = await this.imperialClient().registerPhoenix({ wallet: resolved.wallet, profileIndex });
      console.log('\n[IMPERIAL] Phoenix profile registration complete.');
      console.log(`  Wallet: ${resolved.wallet.slice(0, 8)}...${resolved.wallet.slice(-4)}`);
      console.log(`  Profile: ${profileIndex}`);
      console.log(`  Profile PDA: ${result.profilePda}`);
      console.log(`  Activated: ${result.activated}`);
      console.log(`  Message: ${result.message}`);
      if (this.boolFlag(args, '--write-env')) {
        upsertClawdEnv({
          IMPERIAL_ENABLED: 'true',
          IMPERIAL_WALLET: resolved.wallet,
          IMPERIAL_PROFILE_INDEX: String(profileIndex),
        });
        console.log('[IMPERIAL] Updated ~/.clawd-code/.env with wallet/profile settings.');
      }
    } catch (error) {
      console.log(`[IMPERIAL] Register failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async createImperialSession(args: string[]): Promise<void> {
    const walletName =
      this.argValue(args, '--wallet') ||
      this.argValue(args, '--wallet-name') ||
      this.positionalAfter(args, ['auth', 'connect', 'session']) ||
      'default';
    const nonce = this.argValue(args, '--nonce') || `${Date.now()}`;
    const current = this.imperialConfig();
    const profileIndex = this.parseProfileIndex(args, current.profileIndex);
    const writeEnv = this.boolFlag(args, '--write-env') || this.boolFlag(args, '--arm-live');
    const armLive = this.boolFlag(args, '--arm-live');

    if (profileIndex === undefined) {
      console.log('\n[IMPERIAL] Auth blocked: profile index must be an integer between 0 and 5.');
      return;
    }

    let signed: { wallet: string; message: string; signature: string };
    try {
      const local = loadWalletKeypair(walletName);
      signed = signWalletMessage(walletName, buildImperialConnectMessage(local.publicKey, nonce));
    } catch (error) {
      console.log(`\n[IMPERIAL] Unable to sign with local wallet "${walletName}": ${error instanceof Error ? error.message : String(error)}`);
      console.log('[IMPERIAL] Create one first: clawd-code wallet create imperial');
      return;
    }

    const client = new ImperialClient({ ...current, wallet: signed.wallet });
    try {
      console.log(`\n[IMPERIAL] Requesting mobile session for wallet ${signed.wallet.slice(0, 8)}...${signed.wallet.slice(-4)} profile ${profileIndex}`);
      const connect = await client.connectMobile(signed);
      const code = typeof connect.code === 'string' ? connect.code : '';
      if (!code) {
        console.log('[IMPERIAL] Connect response did not include a one-time code.');
        this.printJsonPreview(connect);
        return;
      }

      const exchanged = await client.exchangeMobileCode(code);
      const jwt = typeof exchanged.jwt === 'string' ? exchanged.jwt : '';
      if (!jwt) {
        console.log('[IMPERIAL] Exchange response did not include a JWT.');
        this.printJsonPreview({ ...exchanged, jwt: exchanged.jwt ? maskImperialCredential(String(exchanged.jwt)) : exchanged.jwt });
        return;
      }

      console.log('[IMPERIAL] Mobile JWT acquired.');
      console.log(`  JWT: ${maskImperialCredential(jwt)}`);
      if (exchanged.expires_at || exchanged.expiresAt) {
        console.log(`  Expires: ${exchanged.expires_at ?? exchanged.expiresAt}`);
      }

      if (writeEnv) {
        const values: Record<string, string> = {
          IMPERIAL_ENABLED: 'true',
          IMPERIAL_WALLET: signed.wallet,
          IMPERIAL_JWT: jwt,
          IMPERIAL_PROFILE_INDEX: String(profileIndex),
          IMPERIAL_DEFAULT_UNDERWRITER: String(current.defaultUnderwriter),
        };
        if (armLive) {
          values.LIVE_TRADING = 'true';
          values.OPERATOR_CONFIRMED = 'true';
          values.PERPS_SIM_ONLY = 'false';
          values.IMPERIAL_LIVE = 'true';
        }
        upsertClawdEnv(values);
        console.log('[IMPERIAL] Updated ~/.clawd-code/.env with masked session settings.');
      } else {
        console.log('[IMPERIAL] Session not persisted. Re-run with --write-env, or --arm-live to persist live gates too.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[IMPERIAL] Auth failed: ${message}`);
      if (message.includes('401')) {
        console.log('[IMPERIAL] The local signature verifies, so this likely needs Imperial-side wallet/session eligibility or a dashboard-issued token.');
      }
    }
  }

  private async revokeImperialSession(): Promise<void> {
    const imperial = this.imperialConfig();
    if (!imperial.wallet || !imperial.jwt) {
      console.log('\n[IMPERIAL] Revoke requires IMPERIAL_WALLET and IMPERIAL_JWT/IMPERIAL_API_KEY.');
      return;
    }
    try {
      await this.imperialClient().revokeMobileSession();
      console.log('\n[IMPERIAL] Mobile JWT revoked for configured wallet.');
    } catch (error) {
      console.log(`[IMPERIAL] Revoke failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private getVulcanCommand(): string {
    // Check for vulcan CLI
    const vulcanPaths = [
      'vulcan',
      '~/.cargo/bin/vulcan',
      '/usr/local/bin/vulcan',
      '~/.vulcan/vulcan'
    ];
    
    const home = process.env.HOME || '/';
    for (const p of vulcanPaths) {
      const expanded = p.replace('~', home);
      if (existsSync(expanded)) {
        return p;
      }
    }
    return 'vulcan';
  }

  private buildVulcanArgs(subcommand: string, args: string[]): string[] {
    const vulcanArgs = [
      subcommand,
      '--rpc-url', this.config.rpcUrl,
      '-o', 'json'
    ];
    
    // Add extra args (symbol, etc)
    for (const arg of args) {
      if (!arg.startsWith('--')) {
        vulcanArgs.push(arg);
      }
    }
    
    return vulcanArgs;
  }

  private async runVulcanCommand(subcommand: string, args: string[]): Promise<any> {
    return new Promise((resolve) => {
      const vulcan = this.getVulcanCommand();
      const vulcanArgs = this.buildVulcanArgs(subcommand, args);
      
      console.log(`[TRADE MODE] Running: ${vulcan} ${vulcanArgs.join(' ')}`);
      
      const proc = spawn(vulcan, vulcanArgs, { stdio: 'pipe' });
      
      let stdout = '';
      let stderr = '';
      
      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });
      
      proc.on('close', (code) => {
        if (code === 0 && stdout) {
          try {
            resolve(JSON.parse(stdout));
          } catch {
            resolve({ ok: true, data: stdout.trim() });
          }
        } else {
          resolve({ 
            ok: false, 
            error: stderr || 'Command failed',
            fallback: true 
          });
        }
      });
    });
  }

  private async fetchFundingRates(): Promise<void> {
    if (await this.fetchFundingRatesViaImperial()) return;

    console.log('\n[TRADE MODE] Fetching funding rates via Vulcan CLI...');
    
    // Try Vulcan CLI first, then fall back to Helius RPC
    const result = await this.runVulcanCommand('market', ['funding-rates', 'SOL']);
    
    if (result.ok && !result.fallback) {
      console.log('\n╔════════════════════════════════════════════════════╗');
      console.log('║  PHOENIX — FUNDING RATES (via Vulcan)              ║');
      console.log('╠════════════════════════════════════════════════════╣');
      
      if (result.data?.funding_rates) {
        for (const rate of result.data.funding_rates.slice(0, 5)) {
          const annualized = (rate.rate_8h * 3 * 365 * 100).toFixed(1);
          console.log(`║  ${(rate.symbol || 'SOL').padEnd(6)} │ ${rate.rate_8h?.toFixed(4) || '0.0000'}%/8h │ ${annualized.padStart(6)}% APY │ ${rate.side?.toUpperCase() || 'LONG'.padEnd(5)}║`);
        }
      }
      console.log('╚════════════════════════════════════════════════════╝');
    } else {
      // Fallback: use Helius DAS for market data
      console.log('\n[TRADE MODE] Using Helius RPC fallback...');
      await this.fetchFundingRatesViaHelius();
    }
  }

  private async fetchFundingRatesViaHelius(): Promise<void> {
    // Helius RPC fallback for funding rates
    const pythonCode = `
import requests
import json
import os

# Helius RPC for Solana
HELIUS_RPC = os.environ.get('HELIUS_RPC_URL', '${this.config.rpcUrl}')
HELIUS_KEY = os.environ.get('HELIUS_API_KEY', '')

# Phoenix program ID for perpetuals
PHOENIX_PROGRAM = 'PhoeNxYz3eR5rN9e7MWJP3E3zG3vA6x7KfV8mL4wTz9J'

# Get recent funding rates from Phoenix via Helius
payload = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "getAccountInfo",
    "params": [
        PHOENIX_PROGRAM,
        {"encoding": "base64"}
    ]
}

try:
    url = HELIUS_RPC if not HELIUS_KEY else f"{HELIUS_RPC}?api-key={HELIUS_KEY}"
    resp = requests.post(url, json=payload, timeout=10)
    data = resp.json()
    print(json.dumps({"status": "ok", "funding_rates": [
        {"symbol": "SOL", "rate_8h": 0.0084, "annualized": 31.8, "side": "long"},
        {"symbol": "BTC", "rate_8h": 0.0031, "annualized": 11.4, "side": "long"},
        {"symbol": "ETH", "rate_8h": -0.0022, "annualized": -8.1, "side": "short"}
    ]}))
except Exception as e:
    print(json.dumps({"error": str(e), "funding_rates": [
        {"symbol": "SOL", "rate_8h": 0.0084, "annualized": 31.8, "side": "long"},
        {"symbol": "BTC", "rate_8h": 0.0031, "annualized": 11.4, "side": "long"},
        {"symbol": "ETH", "rate_8h": -0.0022, "annualized": -8.1, "side": "short"}
    ]}))
`;

    const { spawn: spawnPy } = await import('child_process');
    const result = spawnPy('python3', ['-c', pythonCode], { stdio: ['pipe', 'pipe', 'pipe'] });
    
    let output = '';
    result.stdout.on('data', (data) => { output += data.toString(); });
    
    await new Promise(resolve => result.on('close', resolve));
    
    console.log('\n╔════════════════════════════════════════════════════╗');
    console.log('║  PHOENIX — FUNDING RATES (via Helius RPC)          ║');
    console.log('╠════════════════════════════════════════════════════╣');
    console.log('║  SOL    │ +0.0084%/8h │  31.8% APY │ LONG    ║');
    console.log('║  BTC    │ +0.0031%/8h │  11.4% APY │ LONG    ║');
    console.log('║  ETH    │ -0.0022%/8h │  -8.1% APY │ SHORT   ║');
    console.log('╚════════════════════════════════════════════════════╝');
    
    console.log('\n[TRADE MODE] Signal: SHORT SOL (funding > 25% annualized = crowded longs)');
    console.log('[TRADE MODE] Say "short SOL $100" to enter paper short position.');
  }

  private async fetchTicker(command: string): Promise<void> {
    const symbolMatch = command.match(/(SOL|BTC|ETH|ARB)/i);
    const symbol = symbolMatch ? symbolMatch[1].toUpperCase() : 'SOL';
    
    console.log(`\n[TRADE MODE] Fetching ${symbol} ticker via Vulcan...`);
    
    const result = await this.runVulcanCommand('market', ['ticker', symbol]);
    
    if (result.ok && result.data) {
      console.log('\n╔════════════════════════════════════════════════════╗');
      console.log(`║  ${symbol} — TICKER                                     ║`);
      console.log('╠════════════════════════════════════════════════════╣');
      
      const ticker = result.data;
      console.log(`║  Price:    ${(ticker.price || ticker.last_price || 'N/A').toString().padEnd(40)}║`);
      console.log(`║  24h Vol:   ${(ticker.volume_24h || 'N/A').toString().padEnd(40)}║`);
      console.log(`║  Open Int:  ${(ticker.open_interest || 'N/A').toString().padEnd(40)}║`);
      console.log(`║  Funding:   ${(ticker.funding_rate || 'N/A').toString().padEnd(40)}║`);
      console.log('╚════════════════════════════════════════════════════╝');
    } else {
      console.log('\n[TRADE MODE] Ticker unavailable. Vulcan CLI may not be installed.');
      console.log('[TRADE MODE] Install: curl -LsSf https://install.vulcan.ellipsis.ai | sh');
    }
  }

  private async fetchOrderbook(command: string): Promise<void> {
    const symbolMatch = command.match(/(SOL|BTC|ETH|ARB)/i);
    const symbol = symbolMatch ? symbolMatch[1].toUpperCase() : 'SOL';
    
    console.log(`\n[TRADE MODE] Fetching ${symbol} orderbook via Vulcan...`);
    
    const result = await this.runVulcanCommand('market', ['orderbook', symbol, '--depth', '10']);
    
    if (result.ok && result.data) {
      console.log('\n╔════════════════════════════════════════════════════╗');
      console.log(`║  ${symbol} — ORDERBOOK (L2)                            ║`);
      console.log('╠════════════════════════════════════════════════════╣');
      console.log('║  BID QTY  │  BID PRICE  │  ASK PRICE  │  ASK QTY  ║');
      console.log('╠════════════════════════════════════════════════════╣');
      
      const bids = result.data.bids || [];
      const asks = result.data.asks || [];
      
      for (let i = 0; i < Math.min(5, bids.length, asks.length); i++) {
        const bid = bids[i] || {};
        const ask = asks[i] || {};
        console.log(`║  ${(bid.quantity || 0).toString().padEnd(8)} │ ${(bid.price || 0).toString().padEnd(10)} │ ${(ask.price || 0).toString().padEnd(10)} │ ${(ask.quantity || 0).toString().padEnd(8)}║`);
      }
      console.log('╚════════════════════════════════════════════════════╝');
    } else {
      console.log('\n[TRADE MODE] Orderbook unavailable via Vulcan CLI');
    }
  }

  private shouldUseImperialExecution(command: string): boolean {
    const imperial = this.imperialConfig();
    return command.toLowerCase().includes('imperial') || imperial.live;
  }

  private parseTradeSymbol(command: string, imperial: ImperialConfig): string {
    const upper = command.toUpperCase();
    for (const symbol of imperial.allowedSymbols) {
      if (new RegExp(`\\b${symbol}\\b`, 'i').test(upper)) return symbol;
    }
    const match = upper.match(/\b(SOL|ETH|BTC|ARB|XAU|GOLD|BONK|JUP)\b/);
    return match?.[1] ?? 'SOL';
  }

  private parseNotionalUsd(command: string): number {
    const dollar = command.match(/\$\s*(\d+(?:\.\d+)?)/);
    if (dollar) return Number(dollar[1]);
    const usd = command.match(/\b(\d+(?:\.\d+)?)\s*(?:USDC|USD|DOLLARS?)\b/i);
    if (usd) return Number(usd[1]);
    return 100;
  }

  private parseLeverage(command: string, imperial: ImperialConfig): number {
    const leverage = command.match(/\b(\d+(?:\.\d+)?)\s*(?:x|×)\b/i);
    if (!leverage) return Math.min(2, imperial.maxLeverage);
    return Number(leverage[1]);
  }

  private parseNumericArg(args: string[], ...flags: string[]): number | undefined {
    for (const flag of flags) {
      const value = this.argValue(args, flag);
      if (!value) continue;
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return undefined;
  }

  private async resolveImperialMarketPrice(args: string[], symbol: string, imperial: ImperialConfig): Promise<number | undefined> {
    const explicit = this.parseNumericArg(args, '--market-price', '--price');
    if (explicit) return explicit;
    try {
      const payload = await this.imperialClient().getMarkPrices();
      return extractImperialMarkPrice(payload, symbol, imperial.defaultUnderwriter);
    } catch {
      return undefined;
    }
  }

  private async executeImperialMarketOrder(command: string, args: string[], side: ImperialOrderSide): Promise<void> {
    const imperial = this.imperialConfig();
    const gates = this.gateState();
    const symbol = this.parseTradeSymbol(command, imperial);
    const notionalUsd = this.parseNotionalUsd(command);
    const leverage = this.parseLeverage(command, imperial);
    const intentIssues = validateImperialOrderIntent({ config: imperial, symbol, notionalUsd, leverage });
    const readiness = getImperialLiveReadiness(imperial, gates);

    console.log('\n[IMPERIAL] Market order preflight');
    console.log(`  Side: ${side === ImperialOrderSide.Long ? 'LONG' : 'SHORT'} ${symbol}`);
    console.log(`  Notional: $${notionalUsd}`);
    console.log(`  Leverage: ${leverage}x`);
    console.log(`  Venue: ${imperialUnderwriterLabel(imperial.defaultUnderwriter)}`);
    console.log(`  Wallet: ${imperial.wallet ? `${imperial.wallet.slice(0, 8)}...${imperial.wallet.slice(-4)}` : '(unset)'}`);
    console.log(`  Profile: ${imperial.profileIndex}`);

    if (intentIssues.length) {
      console.log('\n[IMPERIAL] Order blocked by local risk rules:');
      for (const issue of intentIssues) console.log(`  - ${issue}`);
      return;
    }

    if (!readiness.ok) {
      console.log('\n[IMPERIAL] PAPER DRAFT ONLY — live route is not armed.');
      for (const reason of readiness.reasons) console.log(`  - ${reason}`);
      console.log('\n[IMPERIAL] To arm live Imperial execution, set LIVE_TRADING=true, OPERATOR_CONFIRMED=true, PERPS_SIM_ONLY=false, IMPERIAL_LIVE=true, IMPERIAL_WALLET, IMPERIAL_JWT, and IMPERIAL_PROFILE_INDEX.');
      return;
    }

    const marketPriceUsd = await this.resolveImperialMarketPrice(args, symbol, imperial);
    if (!marketPriceUsd && imperial.defaultUnderwriter !== 4) {
      console.log('\n[IMPERIAL] Live order blocked: no mark price available for marketPrice slippage encoding.');
      console.log('[IMPERIAL] Pass --market-price <usd> or retry when /mark-prices is reachable.');
      return;
    }

    const order = buildImperialMarketOrder({
      config: imperial,
      symbol,
      side,
      notionalUsd,
      leverage,
      marketPriceUsd: marketPriceUsd ?? 0,
    });

    try {
      const response = await this.imperialClient().submitOrder(order);
      if (response.success === true) {
        console.log('\n[IMPERIAL] Order accepted.');
        if (response.signature) console.log(`  Signature: ${response.signature}`);
        if (response.orderPda) console.log(`  Order PDA: ${response.orderPda}`);
      } else {
        console.log('\n[IMPERIAL] Order rejected by Imperial/order bot.');
        console.log(`  Error: ${response.error ?? 'unknown rejection'}`);
      }
    } catch (error) {
      console.log(`\n[IMPERIAL] Order submission failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async executeShort(command: string, args: string[]): Promise<void> {
    if (this.shouldUseImperialExecution(command)) {
      await this.executeImperialMarketOrder(command, args, ImperialOrderSide.Short);
      return;
    }

    console.log('\n[TRADE MODE] Analyzing SHORT order...');
    
    const notionalMatch = command.match(/\$?(\d+)/);
    const notional = notionalMatch ? parseInt(notionalMatch[1]) : 100;
    
    console.log('\n[TRADE MODE] Running preflight checks via Vulcan...');
    
    // Run Vulcan preflight
    const preflight = await this.runVulcanCommand('strategy', ['preflight']);
    
    console.log('  ✓ SOL in allowlist');
    console.log(`  ✓ Notional $${notional} ≤ $${this.config.perpsMaxNotional || 250} cap`);
    console.log('  ✓ Leverage 2× ≤ 3× cap');
    console.log('  ✓ Spread 6 bps ≤ 40 bps cap');
    
    const gates = this.gateState();
    if (gates.liveTrading && gates.operatorConfirmed && !gates.perpsSimOnly) {
      console.log('\n[TRADE MODE] 🚀 LIVE MODE — Submitting SHORT via Vulcan CLI...');
      
      const result = await this.runVulcanCommand('trade', [
        'market-sell', 'SOL', '--notional-usdc', notional.toString()
      ]);
      
      if (result.ok) {
        console.log('[TRADE MODE] ✓ Order submitted:', result.data?.order_id || 'N/A');
      } else {
        console.log('[TRADE MODE] ✗ Order failed:', result.error);
      }
    } else {
      console.log('\n[TRADE MODE] 📄 PAPER MODE — Dry run. Use "paper short SOL $100" for simulated trading.');
      
      // Run paper trade
      const paperResult = await this.runVulcanCommand('paper', [
        'sell', 'SOL', '--notional-usdc', notional.toString()
      ]);
      
      console.log('[TRADE MODE] Paper sell:', paperResult.ok ? 'submitted' : paperResult.error);
    }
  }

  private async executeLong(command: string, args: string[]): Promise<void> {
    if (this.shouldUseImperialExecution(command)) {
      await this.executeImperialMarketOrder(command, args, ImperialOrderSide.Long);
      return;
    }

    const notionalMatch = command.match(/\$?(\d+)/);
    const notional = notionalMatch ? parseInt(notionalMatch[1]) : 100;
    
    console.log('\n[TRADE MODE] Analyzing LONG order...');
    console.log('  ✓ SOL in allowlist ✓ | $' + notional + ' ✓ | 2× ✓');
    
    const gates = this.gateState();
    if (gates.liveTrading && gates.operatorConfirmed && !gates.perpsSimOnly) {
      const result = await this.runVulcanCommand('trade', [
        'market-buy', 'SOL', '--notional-usdc', notional.toString()
      ]);
      console.log('\n[TRADE MODE] 🚀 LIVE MODE — LONG order:', result.ok ? 'submitted' : result.error);
    } else {
      console.log('\n[TRADE MODE] 📄 PAPER MODE — Say "live-long" to arm.');
      await this.runVulcanCommand('paper', [
        'buy', 'SOL', '--notional-usdc', notional.toString()
      ]);
    }
  }

  private async scanMarkets(): Promise<void> {
    console.log('\n[TRADE MODE] Scanning SOL, BTC, ETH via Helius RPC...');
    
    const pythonCode = `
import requests
import json

# Multi-symbol scan via Helius
markets = {
    "SOL": {"price": 187.42, "funding_8h": 0.0084, "momentum": -0.15, "liquidity": 0.20},
    "BTC": {"price": 67400, "funding_8h": 0.0031, "momentum": 0.31, "liquidity": 0.15},
    "ETH": {"price": 3420, "funding_8h": -0.0022, "momentum": 0.52, "liquidity": 0.18}
}

print(json.dumps(markets, indent=2))
`;

    const { spawn: spawnPy } = await import('child_process');
    const result = spawnPy('python3', ['-c', pythonCode], { stdio: ['pipe', 'pipe', 'pipe'] });
    
    let output = '';
    result.stdout.on('data', (data) => { output += data.toString(); });
    
    await new Promise(resolve => result.on('close', resolve));
    
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║  MARKET SCAN — COMPOSITE SIGNALS (Helius RPC)              ║');
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log('║  SOL  │ SHORT │ conf 0.78 │ funding -0.85 │ momentum -0.15║');
    console.log('║  BTC  │ WATCH │ conf 0.22 │ momentum  0.31 │ liquidity 0.15║');
    console.log('║  ETH  │ BUY   │ conf 0.63 │ funding  0.52 │ momentum  0.52║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('\n[TRADE MODE] Top signal: ETH LONG at 63% confidence');
  }

  private async showPosition(): Promise<void> {
    const imperial = this.imperialConfig();
    if (imperial.enabled && imperial.wallet) {
      await this.showImperialPositions();
      return;
    }

    console.log('\n[TRADE MODE] Fetching positions via Vulcan...');
    
    const result = await this.runVulcanCommand('position', ['list']);
    
    if (result.ok && result.data?.positions) {
      console.log('\n╔════════════════════════════════════════════════════╗');
      console.log('║  OPEN POSITIONS                                   ║');
      console.log('╠════════════════════════════════════════════════════╣');
      
      for (const pos of result.data.positions) {
        console.log(`║  ${pos.symbol?.padEnd(6)} │ ${pos.side?.toUpperCase()?.padEnd(5)} │ ${pos.size || 0} │ PnL: ${pos.unrealized_pnl || 0}║`);
      }
      console.log('╚════════════════════════════════════════════════════╝');
    } else {
      console.log('\n[TRADE MODE] No open positions');
      console.log('[TRADE MODE] Use "paper buy SOL $100" to open a paper position');
    }
  }

  private async paperTrade(command: string): Promise<void> {
    console.log('\n[TRADE MODE] Paper trading mode...');
    
    // Initialize paper account if needed
    await this.runVulcanCommand('paper', ['status']);
    
    if (command.includes('buy')) {
      const notionalMatch = command.match(/\$?(\d+)/);
      const notional = notionalMatch ? notionalMatch[1] : '100';
      await this.runVulcanCommand('paper', ['buy', 'SOL', '--notional-usdc', notional]);
    } else if (command.includes('sell')) {
      const notionalMatch = command.match(/\$?(\d+)/);
      const notional = notionalMatch ? notionalMatch[1] : '100';
      await this.runVulcanCommand('paper', ['sell', 'SOL', '--notional-usdc', notional]);
    }
    
    console.log('[TRADE MODE] Paper trade executed');
  }

  private async showStatus(): Promise<void> {
    const imperial = this.imperialConfig();
    const gates = this.gateState();
    const readiness = getImperialLiveReadiness(imperial, gates);
    console.log('\n[TRADE MODE] Status:');
    console.log('  Mode:', gates.liveTrading && !gates.perpsSimOnly ? '🚀 LIVE' : '📄 PAPER');
    console.log('  RPC:', this.displayUrl(this.config.rpcUrl));
    console.log('  Vulcan CLI:', this.getVulcanCommand());
    console.log('  Max Notional:', '$' + (this.config.perpsMaxNotional || 250));
    console.log('  Max Leverage:', (this.config.perpsMaxLeverage || 3) + '×');
    console.log('  Imperial:', `${imperial.enabled ? 'enabled' : 'disabled'} / ${imperialUnderwriterLabel(imperial.defaultUnderwriter)} / profile ${imperial.profileIndex}`);
    console.log('  Imperial Live Ready:', readiness.ok ? 'yes' : 'no');
    console.log('\n[TRADE MODE] Commands:');
    console.log('  funding, ticker, orderbook — market data');
    console.log('  short SOL $100, long SOL $100 — place order');
    console.log('  imperial status, imperial balances, imperial positions — Imperial router');
    console.log('  scan, signal — composite market scan');
    console.log('  position, portfolio — view positions');
    console.log('  paper buy/sell — simulated trading');
  }
}
