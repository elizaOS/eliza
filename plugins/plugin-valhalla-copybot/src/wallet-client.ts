import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { getWallets } from "@wallet-standard/app";

export type WalletChoice = "phantom" | "solflare";

type ReadOnlyAdapter = {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
  publicKey: { toBase58: () => string } | null;
};

const adapters: Record<WalletChoice, ReadOnlyAdapter> = {
  phantom: new PhantomWalletAdapter(),
  solflare: new SolflareWalletAdapter(),
};

export function shortAddress(address: string): string {
  const text = address.trim();
  if (text.length <= 4) return `…${text}`;
  return `…${text.slice(-4)}`;
}

export function phantomBrowseLink(pageUrl: string): string {
  return `https://phantom.app/ul/browse/${encodeURIComponent(pageUrl)}?ref=valhalla`;
}

export function solflareBrowseLink(pageUrl: string): string {
  return `https://solflare.com/ul/v1/browse/${encodeURIComponent(pageUrl)}`;
}

/** Wallet Standard names, Phantom and Solflare first. */
export function detectedWalletNames(): string[] {
  const found = getWallets().get().map((wallet) => wallet.name);
  const preferred = ["Phantom", "Solflare"].filter((name) => found.includes(name));
  const rest = found.filter((name) => !preferred.includes(name));
  return [...preferred, ...rest];
}

export async function connectReadOnly(choice: WalletChoice): Promise<{ address: string; short: string }> {
  const adapter = adapters[choice];
  await adapter.connect();
  const address = adapter.publicKey?.toBase58() ?? "";
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    throw new Error("The wallet did not share a public key.");
  }
  return { address, short: shortAddress(address) };
}

export async function disconnectReadOnly(choice: WalletChoice): Promise<void> {
  await adapters[choice].disconnect();
}

/** Optional ownership proof. This is a message signature, not a transaction. */
export async function proveReadOnly(choice: WalletChoice): Promise<{ address: string; proof: string }> {
  const adapter = adapters[choice];
  const address = adapter.publicKey?.toBase58() ?? "";
  if (!address) throw new Error("Connect a wallet first.");
  const message = new TextEncoder().encode(`Valhalla read-only link\n${address}`);
  const signature = await adapter.signMessage(message);
  return { address, proof: btoa(String.fromCharCode(...signature)) };
}
