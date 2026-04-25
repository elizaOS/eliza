/**
 * Smoke test: probe a paid plugin route for HTTP 402 + x402 body.
 *
 * Usage (from packages/agent):
 *   X402_API_URL=http://127.0.0.1:3000 X402_TEST_PATH=/demo/paid bun run scripts/test-x402-plugin-route.ts
 *
 * Optional: install `x402-fetch` and set wallet env vars from that package’s docs
 * to attempt a second paid request (skipped if the import fails).
 */

const base = (process.env.X402_API_URL ?? "http://127.0.0.1:3000").replace(
  /\/$/,
  "",
);
const testPath = process.env.X402_TEST_PATH ?? "/demo/paid";

async function probe402(url: string): Promise<Response> {
  console.log(`[x402 smoke] GET ${url}`);
  return fetch(url, { method: "GET" });
}

async function maybePaidFetch(url: string): Promise<void> {
  try {
    const mod = await import("x402-fetch");
    const wrap = mod.wrapFetchWithPayment as typeof fetch | undefined;
    if (typeof wrap !== "function") {
      console.log(
        "[x402 smoke] x402-fetch has no wrapFetchWithPayment — skipping paid retry",
      );
      return;
    }
    console.log(
      "[x402 smoke] Retrying with wrapFetchWithPayment (x402-fetch)…",
    );
    const r = await wrap(fetch)(url, { method: "GET" });
    console.log("[x402 smoke] Paid retry status:", r.status);
    const text = await r.text();
    console.log("[x402 smoke] Body (truncated):", text.slice(0, 500));
  } catch (e) {
    console.log(
      "[x402 smoke] Skipping paid retry (install x402-fetch + wallet env):",
      e instanceof Error ? e.message : String(e),
    );
  }
}

async function main(): Promise<void> {
  const url = `${base}${testPath.startsWith("/") ? testPath : `/${testPath}`}`;
  const res = await probe402(url);
  console.log("[x402 smoke] Status:", res.status);
  const ct = res.headers.get("content-type") ?? "";
  const body = ct.includes("json") ? await res.json() : await res.text();
  console.log(
    "[x402 smoke] Body:",
    typeof body === "string" ? body : JSON.stringify(body, null, 2),
  );

  if (res.status === 402 && process.env.X402_TRY_PAID_FETCH === "1") {
    await maybePaidFetch(url);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
