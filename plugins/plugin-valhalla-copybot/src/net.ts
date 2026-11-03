/** Every network wait ends. A hung RPC must not freeze the loop. */
export function netTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.VALHALLA_NET_TIMEOUT_MS);
  if (!Number.isFinite(raw)) return 8_000;
  return Math.min(20_000, Math.max(1_000, raw));
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export function tail4(value: string | null | undefined): string {
  const text = String(value ?? "").trim();
  if (!text) return "—";
  if (text.length <= 4) return `…${text}`;
  return `…${text.slice(-4)}`;
}

const SECRET_RE = /[1-9A-HJ-NP-Za-km-z]{32,}/g;

/** Drop long keys and base58 blobs before a line is stored or shown. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has("api-key")) parsed.searchParams.set("api-key", "[redacted]");
    return parsed.toString();
  } catch {
    return url.replace(/api-key=[^&]+/g, "api-key=[redacted]");
  }
}

export function redactSecrets(text: string): string {
  return text.replace(SECRET_RE, (match) => `…${match.slice(-4)}`);
}
