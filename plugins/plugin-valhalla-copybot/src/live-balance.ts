/** A live SOL balance from an RPC. The caller must fetch again. This does not keep a cache. */

export async function fetchLiveSol(
  address: string,
  rpcUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ sol: number; slot: number | null }> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    throw new Error("That is not a Solana address.");
  }
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getBalance",
      params: [address],
    }),
  });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const body = (await response.json()) as {
    result?: { value?: number; context?: { slot?: number } };
    error?: { message?: string };
  };
  if (body.error) throw new Error(body.error.message || "RPC error");
  const lamports = Number(body.result?.value);
  if (!Number.isFinite(lamports)) throw new Error("RPC did not return a balance.");
  return { sol: lamports / 1_000_000_000, slot: body.result?.context?.slot ?? null };
}

export function publicRpcUrl(env: Record<string, string | undefined>): string {
  const key = env.HELIUS_API_KEY?.trim();
  if (key) return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
  return "https://api.mainnet-beta.solana.com";
}
