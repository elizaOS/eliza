export interface BrainScore {
  score: number;
  flags: string[];
  disclaimer: string;
  upstream?: string;
}

export interface WalletSummary {
  tail: string;
  sol: number | null;
  publicDataOnly: true;
  note: string;
  disclaimer: string;
}

export class BrainClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string
  ) {}

  async health(): Promise<{ ok: boolean }> {
    return this.get("/v1/health", false);
  }

  async score(mint: string): Promise<BrainScore> {
    return this.get(`/v1/score/${encodeURIComponent(mint)}`);
  }

  async batch(mints: string[]): Promise<{ results: BrainScore[]; disclaimer: string }> {
    return this.send("/v1/score/batch", { mints: mints.slice(0, 20) });
  }

  async walletSummary(pubkey: string): Promise<WalletSummary> {
    return this.get(`/v1/wallet/${encodeURIComponent(pubkey)}/summary`);
  }

  async trending(): Promise<{ items: { mint: string; symbol: string; name: string }[]; disclaimer: string }> {
    return this.get("/v1/trending");
  }

  async usage(): Promise<{ plan: string; callsToday: number; limit: number; disclaimer: string }> {
    return this.get("/v1/usage");
  }

  private async get<T>(path: string, auth = true): Promise<T> {
    const headers: Record<string, string> = {};
    if (auth) headers.authorization = `Bearer ${this.apiKey}`;
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, { headers });
    if (!response.ok) throw new Error(`Brain API HTTP ${response.status}`);
    return (await response.json()) as T;
  }

  private async send<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Brain API HTTP ${response.status}`);
    return (await response.json()) as T;
  }
}
