/**
 * Clawd Code — x402 Payment Integration
 * Autonomous commerce via HTTP 402 payments
 */

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface X402RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  amount?: number; // USDC to pay
  destination?: string; // Solana wallet address
}

export class X402Client {
  private gatewayUrl: string;
  private paymentSecret: string;

  constructor(configPath: string = join(homedir(), '.clawd-code', '.env')) {
    let gatewayUrl = 'https://x402.wtf';
    let paymentSecret = '';

    try {
      const config = readFileSync(configPath, 'utf-8');
      for (const line of config.split('\n')) {
        const [key, ...rest] = line.split('=');
        if (key === 'X402_GATEWAY_URL') gatewayUrl = rest.join('=').trim();
        if (key === 'X402_PAYMENT_SECRET') paymentSecret = rest.join('=').trim();
      }
    } catch {
      // No config file — use defaults.
    }

    this.gatewayUrl = gatewayUrl;
    this.paymentSecret = paymentSecret;
  }

  /**
   * Build the request URL and headers for an x402-gated call (pure, testable).
   */
  buildRequest(endpoint: string, options: X402RequestOptions = {}): { url: string; init: RequestInit } {
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

    const url = endpoint.startsWith('http') ? endpoint : `${this.gatewayUrl}${endpoint}`;

    return {
      url,
      init: {
        method,
        headers: requestHeaders,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
    };
  }

  /**
   * Make a payment-gated request to any x402-enabled endpoint
   */
  async request<T>(endpoint: string, options: X402RequestOptions = {}): Promise<T> {
    const { url, init } = this.buildRequest(endpoint, options);

    const response = await fetch(url, init);
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`x402 request failed: ${endpoint} (${response.status}) ${text.slice(0, 200)}`);
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
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
      const response = await this.request<{ balance: number }>(`/api/balance/${walletAddress}`, {});
      return response.balance >= requiredAmount;
    } catch {
      return false;
    }
  }
}

// Export singleton
export const x402 = new X402Client();
