/**
 * Clawd Code — x402 Payment Integration
 * Autonomous commerce via HTTP 402 payments
 */

import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export class X402Client {
  private gatewayUrl: string;
  private paymentSecret: string;

  constructor() {
    const configPath = join(homedir(), '.clawd-code', '.env');
    let gatewayUrl = 'https://x402.wtf';
    let paymentSecret = '';

    try {
      const config = readFileSync(configPath, 'utf-8');
      for (const line of config.split('\n')) {
        const [key, ...rest] = line.split('=');
        if (key === 'X402_GATEWAY_URL') gatewayUrl = rest.join('=').trim();
        if (key === 'X402_PAYMENT_SECRET') paymentSecret = rest.join('=').trim();
      }
    } catch {}

    this.gatewayUrl = gatewayUrl;
    this.paymentSecret = paymentSecret;
  }

  /**
   * Make a payment-gated request to any x402-enabled endpoint
   */
  async request<T>(endpoint: string, options: {
    method?: string;
    headers?: Record<string, string>;
    body?: any;
    amount?: number;      // USDC to pay
    destination?: string;  // Solana wallet address
  }): Promise<T> {
    const { method = 'GET', headers = {}, body, amount = 0, destination } = options;

    const requestHeaders: Record<string, string> = {
      ...headers,
      'Content-Type': 'application/json',
      // x402 payment header
      'X-402-Amount': amount.toString(),
      'X-402-Gateway': this.gatewayUrl,
      ...(destination ? { 'X-402-Destination': destination } : {}),
    };

    if (this.paymentSecret) {
      requestHeaders['Authorization'] = `Bearer ${this.paymentSecret}`;
    }

    return new Promise((resolve, reject) => {
      const url = endpoint.startsWith('http') ? endpoint : `${this.gatewayUrl}${endpoint}`;
      const data = body ? JSON.stringify(body) : '';

      // Use curl for HTTP requests with x402 headers
      const curlArgs = ['-s', '-X', method, url];

      for (const [key, value] of Object.entries(requestHeaders)) {
        curlArgs.push('-H', `${key}: ${value}`);
      }

      if (data) {
        curlArgs.push('-d', data);
      }

      const proc = spawn('curl', curlArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
      
      let output = '';
      proc.stdout.on('data', (chunk) => { output += chunk.toString(); });
      proc.stderr.on('data', (chunk) => { /* suppress stderr */ });

      proc.on('close', (code) => {
        if (code === 0) {
          try {
            resolve(JSON.parse(output));
          } catch {
            resolve(output as any);
          }
        } else {
          reject(new Error(`x402 request failed: ${endpoint}`));
        }
      });
    });
  }

  /**
   * Pay for a service and get a session token
   */
  async payAndGetToken(service: string, amount: number): Promise<string> {
    const response = await this.request<{ token: string }>('/api/pay', {
      method: 'POST',
      body: { service, amount },
      amount,
    });
    return response.token;
  }

  /**
   * Check if a wallet has sufficient balance for a payment
   */
  async checkBalance(walletAddress: string, requiredAmount: number): Promise<boolean> {
    try {
      const response = await this.request<{ balance: number }>(
        `/api/balance/${walletAddress}`,
        {}
      );
      return response.balance >= requiredAmount;
    } catch {
      return false;
    }
  }
}

// Export singleton
export const x402 = new X402Client();