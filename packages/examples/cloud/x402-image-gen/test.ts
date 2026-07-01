/**
 * Local smoke + flow test for PayPerPixel.
 *
 * Spins up an in-process MOCK Eliza Cloud (x402 request/settle + image gen +
 * earnings) and the real app server as a subprocess pointed at the mock, then
 * drives the full x402 handshake end-to-end — no real crypto, no live cloud:
 *
 *   /health → /api/config → quote (402) → settle+generate (200) → earnings → idempotency (409)
 */

const APP_ID = "00000000-0000-4000-8000-000000000000";

// ---- mock Eliza Cloud ------------------------------------------------------

const seen = {
  createAppId: "" as string | null,
  settledId: "",
  generatePrompt: "",
};

const mock = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (req.method === "POST" && pathname === "/api/v1/x402/requests") {
      const body = (await req.json()) as { appId?: string; amountUsd?: number };
      seen.createAppId = body.appId ?? null;
      const view = {
        id: "pay_test_1",
        status: "pending",
        paid: false,
        amountUsd: body.amountUsd ?? 0.05,
        platformFeeUsd: 0.0005,
        serviceFeeUsd: 0.01,
        totalChargedUsd: (body.amountUsd ?? 0.05) + 0.0105,
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x000000000000000000000000000000000000dEaD",
        description: "Image",
        appId: body.appId,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      };
      return Response.json({
        success: true,
        paymentRequest: view,
        paymentRequired: { x402Version: 2, accepts: [{ payTo: view.payTo }] },
        paymentRequiredHeader: Buffer.from("{}").toString("base64"),
      });
    }

    const settleMatch = pathname.match(
      /^\/api\/v1\/x402\/requests\/([^/]+)\/settle$/,
    );
    if (req.method === "POST" && settleMatch) {
      seen.settledId = decodeURIComponent(settleMatch[1]);
      return Response.json({
        success: true,
        paymentRequest: {
          id: seen.settledId,
          status: "confirmed",
          paid: true,
          amountUsd: 0.05,
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x000000000000000000000000000000000000dEaD",
          description: "Image",
          transaction: "0xtesthash",
          payer: "0xpayer",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          paidAt: new Date().toISOString(),
        },
      });
    }

    if (req.method === "POST" && pathname === "/api/v1/generate-image") {
      const body = (await req.json()) as { prompt?: string };
      seen.generatePrompt = body.prompt ?? "";
      return Response.json({
        images: [{ url: "https://example.test/generated.png" }],
        numImages: 1,
      });
    }

    if (
      req.method === "GET" &&
      pathname === `/api/v1/apps/${APP_ID}/earnings`
    ) {
      return Response.json({
        success: true,
        earnings: {
          totalLifetimeEarnings: 0.05,
          withdrawableBalance: 0.05,
          totalPurchaseEarnings: 0.05,
        },
      });
    }

    return new Response("mock: unknown route", { status: 404 });
  },
});

const mockUrl = `http://127.0.0.1:${mock.port}`;

// ---- app server (subprocess) ----------------------------------------------

const port = 30_000 + Math.floor(Math.random() * 10_000);
const baseUrl = `http://127.0.0.1:${port}`;

const proc = Bun.spawn(["bun", "run", "server.ts"], {
  cwd: import.meta.dir,
  env: {
    ...process.env,
    PORT: String(port),
    ELIZA_CLOUD_URL: mockUrl,
    ELIZAOS_CLOUD_API_KEY: "test-key",
    ELIZA_APP_ID: APP_ID,
    X402_PRICE_USD: "0.05",
  },
  stderr: "pipe",
  stdout: "pipe",
});

const decoder = new TextDecoder();
let output = "";
async function collect(stream: ReadableStream<Uint8Array> | null) {
  if (!stream) return;
  const reader = stream.getReader();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return;
    output += decoder.decode(chunk.value);
  }
}
const readers = [
  collect(proc.stdout).catch(() => {}),
  collect(proc.stderr).catch(() => {}),
];
let exited = false;
proc.exited.then(() => {
  exited = true;
});

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`${message}\n--- server output ---\n${output}`);
}

try {
  const started = Date.now();
  let ready = false;
  while (!ready && Date.now() - started < 10_000) {
    if (exited) break;
    try {
      const h = await fetch(`${baseUrl}/health`);
      ready = h.status === 200 && (await h.text()) === "ok";
    } catch {
      await Bun.sleep(100);
    }
  }
  assert(ready, `server did not start on ${baseUrl}`);

  // config
  const config = (await (await fetch(`${baseUrl}/api/config`)).json()) as {
    configured?: boolean;
    app_id?: string;
    price_usd?: number;
  };
  assert(config.configured === true, "expected configured=true");
  assert(
    config.app_id === APP_ID,
    `expected app_id ${APP_ID}, got ${config.app_id}`,
  );
  assert(
    config.price_usd === 0.05,
    `expected price 0.05, got ${config.price_usd}`,
  );

  // step 1: quote → 402
  const quoteRes = await fetch(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "a neon koi in the rain" }),
  });
  assert(
    quoteRes.status === 402,
    `expected 402 from quote, got ${quoteRes.status}`,
  );
  const quote = (await quoteRes.json()) as {
    paymentRequestId?: string;
    status?: string;
  };
  assert(
    quote.paymentRequestId === "pay_test_1",
    "quote missing paymentRequestId",
  );
  assert(
    seen.createAppId === APP_ID,
    "payment request was not bound to the appId",
  );

  // step 3: settle + generate → 200 with image
  const genRes = await fetch(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: "a neon koi in the rain",
      paymentRequestId: quote.paymentRequestId,
      paymentPayload: { x402Version: 2, payload: { signature: "0xsig" } },
    }),
  });
  assert(
    genRes.status === 200,
    `expected 200 from generate, got ${genRes.status}`,
  );
  const gen = (await genRes.json()) as {
    image?: { url?: string };
    transaction?: string;
  };
  assert(
    gen.image?.url === "https://example.test/generated.png",
    "generate did not return the image",
  );
  assert(
    gen.transaction === "0xtesthash",
    "generate did not return the settlement tx",
  );
  assert(
    seen.settledId === "pay_test_1",
    "settle was not called with the payment id",
  );
  assert(
    seen.generatePrompt === "a neon koi in the rain",
    "prompt was not forwarded to generate",
  );

  // earnings (money-out side)
  const earnings = (await (await fetch(`${baseUrl}/api/earnings`)).json()) as {
    earnings?: { withdrawableBalance?: number };
  };
  assert(
    earnings.earnings?.withdrawableBalance === 0.05,
    "earnings did not surface",
  );

  // idempotency: the same payment cannot mint a second image
  const dupe = await fetch(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: "a neon koi in the rain",
      paymentRequestId: quote.paymentRequestId,
      paymentPayload: { x402Version: 2, payload: { signature: "0xsig" } },
    }),
  });
  assert(
    dupe.status === 409,
    `expected 409 on duplicate generate, got ${dupe.status}`,
  );

  console.log("PayPerPixel local flow test passed");
} finally {
  proc.kill();
  await proc.exited.catch(() => {});
  await Promise.all(readers);
  mock.stop(true);
}
