/**
 * Clawd Code — Environment Verification & Preflight
 * (Adapted from clawd-grok/src/verify/environment.ts)
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface VerifyResult {
  name: string;
  ok: boolean;
  message: string;
  remedy?: string;
}

export class EnvironmentVerifier {
  private results: VerifyResult[] = [];

  /**
   * Run all preflight checks
   */
  verifyAll(): VerifyResult[] {
    this.results = [];
    this.checkNodeVersion();
    this.checkXaiKey();
    this.checkHeliusRpc();
    this.checkPhoenixUrl();
    this.checkVulcanCli();
    this.checkSafetyGates();
    this.checkConfigFile();
    this.checkWorkspace();
    return this.results;
  }

  private checkNodeVersion(): void {
    const v = process.version;
    const major = parseInt(v.slice(1).split('.')[0]);
    this.results.push({
      name: 'Node.js version',
      ok: major >= 18,
      message: `Node ${v} (need ≥18)`,
      remedy: major < 18 ? 'Install Node 18+: nvm install 18' : undefined,
    });
  }

  private checkXaiKey(): void {
    const key = process.env.XAI_API_KEY;
    this.results.push({
      name: 'xAI Grok API key',
      ok: !!key,
      message: key ? 'XAI_API_KEY set' : 'XAI_API_KEY not set',
      remedy: !key ? 'Get key from https://console.x.ai and set in ~/.clawd-code/.env' : undefined,
    });
  }

  private checkHeliusRpc(): void {
    const rpc = process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL;
    this.results.push({
      name: 'Helius RPC endpoint',
      ok: !!rpc && rpc.includes('helius'),
      message: rpc ? `Using ${rpc.slice(0, 60)}...` : 'No RPC configured',
      remedy: !rpc ? 'Set HELIUS_RPC_URL in ~/.clawd-code/.env (get key from helius.dev)' : undefined,
    });
  }

  private checkPhoenixUrl(): void {
    const url = process.env.PHOENIX_RISE_URL || 'https://api.phoenix.gg/enclave';
    this.results.push({
      name: 'Phoenix Rise endpoint',
      ok: !!url,
      message: url,
      remedy: undefined,
    });
  }

  private checkVulcanCli(): void {
    const paths = ['vulcan', '~/.cargo/bin/vulcan', '/usr/local/bin/vulcan'];
    const home = process.env.HOME || '/';
    let found = false;
    for (const p of paths) {
      if (existsSync(p.replace('~', home))) {
        found = true;
        break;
      }
    }
    this.results.push({
      name: 'Vulcan CLI (Phoenix perps)',
      ok: found,
      message: found ? 'Vulcan CLI found' : 'Vulcan CLI not found',
      remedy: !found ? 'Install: curl -LsSf https://install.vulcan.ellipsis.ai | sh' : undefined,
    });
  }

  private checkSafetyGates(): void {
    const live = process.env.LIVE_TRADING === 'true';
    const confirmed = process.env.OPERATOR_CONFIRMED === 'true';
    const sim = process.env.PERPS_SIM_ONLY === 'true';
    
    if (live && !confirmed) {
      this.results.push({
        name: 'Safety gates',
        ok: false,
        message: 'LIVE_TRADING=true but OPERATOR_CONFIRMED=false',
        remedy: 'Set OPERATOR_CONFIRMED=true after reviewing safety docs',
      });
    } else if (live && !sim) {
      this.results.push({
        name: 'Safety gates',
        ok: false,
        message: 'LIVE_TRADING=true but PERPS_SIM_ONLY=false',
        remedy: 'Confirm PERPS_SIM_ONLY=false to enable real execution',
      });
    } else {
      this.results.push({
        name: 'Safety gates',
        ok: true,
        message: live ? 'LIVE mode (all gates armed)' : 'PAPER mode (default)',
      });
    }
  }

  private checkConfigFile(): void {
    const envPath = join(homedir(), '.clawd-code', '.env');
    const exists = existsSync(envPath);
    this.results.push({
      name: 'Config file (~/.clawd-code/.env)',
      ok: exists,
      message: exists ? 'Config found' : 'Config not found',
      remedy: !exists ? 'cp agents/clawd-code/.env.example ~/.clawd-code/.env' : undefined,
    });
  }

  private checkWorkspace(): void {
    const cwd = process.cwd();
    const hasPkg = existsSync(join(cwd, 'package.json'));
    this.results.push({
      name: 'Workspace',
      ok: true,
      message: cwd,
    });
  }

  /**
   * Print a verification report
   */
  printReport(results?: VerifyResult[]): { ok: boolean; failed: VerifyResult[] } {
    const items = results || this.results;
    const failed = items.filter(r => !r.ok);
    
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║  CLAWD CODE — ENVIRONMENT VERIFICATION                       ║');
    console.log('╠════════════════════════════════════════════════════════════╣');
    
    for (const r of items) {
      const icon = r.ok ? '✓' : '✗';
      const status = r.ok ? 'OK' : 'FAIL';
      console.log(`║  [${icon}] ${r.name.padEnd(35)} ${status.padEnd(5)}║`);
      console.log(`║      ${r.message.substring(0, 50).padEnd(50)}║`);
      if (r.remedy) {
        console.log(`║      → ${r.remedy.substring(0, 46).padEnd(46)}║`);
      }
    }
    
    console.log('╠════════════════════════════════════════════════════════════╣');
    if (failed.length === 0) {
      console.log('║  ✓ ALL CHECKS PASSED — Ready to run                          ║');
    } else {
      console.log(`║  ✗ ${failed.length} CHECK(S) FAILED — Fix above to enable features    ║`);
    }
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    
    return { ok: failed.length === 0, failed };
  }

  /**
   * Load env file and re-check (must be called after loading)
   */
  static loadEnvFile(path?: string): Record<string, string> {
    const envPath = path || join(homedir(), '.clawd-code', '.env');
    const vars: Record<string, string> = {};
    try {
      const env = readFileSync(envPath, 'utf-8');
      for (const line of env.split('\n')) {
        const [key, ...rest] = line.split('=');
        if (key && !key.startsWith('#')) {
          vars[key.trim()] = rest.join('=').trim();
          // Also set in process.env so verifier sees them
          if (!process.env[key.trim()]) {
            process.env[key.trim()] = rest.join('=').trim();
          }
        }
      }
    } catch {}
    return vars;
  }
}