const port = 30_000 + Math.floor(Math.random() * 10_000);
const baseUrl = `http://127.0.0.1:${port}`;
const cloudPort = port + 2;
const cloudBaseUrl = `http://127.0.0.1:${cloudPort}`;

const SESSION_SECRET = "test-session-secret";
const APP_ID = "00000000-0000-4000-8000-000000000000";
const OWNER_KEY = "eliza_test_owner_key";
const AFFILIATE_CODE = "AFF-TEST";

const cloudRequests: Array<{
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}> = [];

const fakeCloud = Bun.serve({
  port: cloudPort,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const headers = Object.fromEntries(req.headers.entries());
    const record: {
      path: string;
      method: string;
      headers: Record<string, string>;
      body?: unknown;
    } = { path: url.pathname, method: req.method, headers };
    cloudRequests.push(record);

    if (url.pathname === "/api/v1/app-auth/session" && req.method === "GET") {
      if (
        req.headers.get("authorization") !== "Bearer eac_good" ||
        req.headers.get("x-app-id") !== APP_ID
      ) {
        return Response.json({ error: "bad exchange" }, { status: 401 });
      }
      return Response.json({
        user: {
          id: "cloud-user-1",
          email: "cloud-user@example.test",
          name: "Cloud User",
        },
      });
    }

    if (url.pathname === "/api/v1/messages" && req.method === "POST") {
      record.body = await req.json().catch(() => null);
      if (
        req.headers.get("authorization") !== `Bearer ${OWNER_KEY}` ||
        req.headers.get("x-app-id") !== APP_ID ||
        req.headers.get("x-affiliate-code") !== AFFILIATE_CODE
      ) {
        return Response.json({ error: "bad proxy headers" }, { status: 401 });
      }
      return Response.json({
        content: [{ type: "text", text: "fake cloud reply" }],
      });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },
});

const proc = Bun.spawn(["bun", "run", "server.ts"], {
  cwd: import.meta.dir,
  env: {
    ...process.env,
    ELIZA_AFFILIATE_CODE: AFFILIATE_CODE,
    ELIZA_APP_ID: APP_ID,
    ELIZA_CLOUD_URL: cloudBaseUrl,
    ELIZAOS_CLOUD_API_KEY: OWNER_KEY,
    EDAD_SESSION_SECRET: SESSION_SECRET,
    PORT: String(port),
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

const outputReaders = [
  collect(proc.stdout).catch(() => {}),
  collect(proc.stderr).catch(() => {}),
];
let exited = false;
proc.exited.then(() => {
  exited = true;
});

try {
  const started = Date.now();
  let ready = false;

  while (!ready && Date.now() - started < 10_000) {
    if (exited) break;
    try {
      const health = await fetch(`${baseUrl}/health`);
      ready = health.status === 200 && (await health.text()) === "ok";
    } catch {
      await Bun.sleep(100);
    }
  }

  if (!ready) {
    throw new Error(
      `eDad smoke test server did not start on ${baseUrl}\n${output}`,
    );
  }

  const health = await fetch(`${baseUrl}/health`);
  if (health.status !== 200 || (await health.text()) !== "ok") {
    throw new Error(`Unexpected health response: ${health.status}`);
  }

  const config = await fetch(`${baseUrl}/api/config`);
  if (config.status !== 200) {
    throw new Error(`Unexpected config response: ${config.status}`);
  }

  const body = (await config.json()) as {
    affiliate_code?: string;
    app_id?: string;
    cloud_url?: string;
  };

  if (
    body.affiliate_code !== AFFILIATE_CODE ||
    body.app_id !== APP_ID ||
    body.cloud_url !== cloudBaseUrl
  ) {
    throw new Error(`Unexpected config body: ${JSON.stringify(body)}`);
  }

  // ── App-session helper round-trip (pure, no network) ──────────────────────
  const { mintAppSession, verifyAppSession } = await import("./app-session.ts");
  const minted = mintAppSession("user-123", SESSION_SECRET);
  if (verifyAppSession(minted, SESSION_SECRET) !== "user-123") {
    throw new Error("app-session: valid token did not verify to its user id");
  }
  if (verifyAppSession(minted, "wrong-secret") !== null) {
    throw new Error("app-session: token verified under the WRONG secret");
  }
  if (verifyAppSession(`${minted}tamper`, SESSION_SECRET) !== null) {
    throw new Error("app-session: tampered token verified");
  }
  const expired = mintAppSession("u", SESSION_SECRET, -1);
  if (verifyAppSession(expired, SESSION_SECRET) !== null) {
    throw new Error("app-session: expired token verified");
  }

  // ── Auth gating: messages/history require a valid app session ──────────────
  const noAuth = await fetch(`${baseUrl}/api/messages/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (noAuth.status !== 401) {
    throw new Error(
      `messages without a session should 401, got ${noAuth.status}`,
    );
  }
  const forged = await fetch(`${baseUrl}/api/messages/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-app-session": "forged.token",
    },
    body: "{}",
  });
  if (forged.status !== 401) {
    throw new Error(
      `messages with a forged session should 401, got ${forged.status}`,
    );
  }

  // ── Exchange route: rejects a missing code (without contacting cloud) ──────
  const noCode = await fetch(`${baseUrl}/api/auth/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (noCode.status !== 400) {
    throw new Error(`exchange without a code should 400, got ${noCode.status}`);
  }

  // ── Successful OAuth code exchange mints an app session ───────────────────
  const exchange = await fetch(`${baseUrl}/api/auth/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "eac_good" }),
  });
  if (exchange.status !== 200) {
    throw new Error(
      `exchange with a good code should 200, got ${exchange.status}`,
    );
  }
  const exchanged = (await exchange.json()) as {
    session?: string;
    user?: { id?: string; email?: string | null; name?: string | null };
  };
  if (!exchanged.session || exchanged.user?.id !== "cloud-user-1") {
    throw new Error(`unexpected exchange body: ${JSON.stringify(exchanged)}`);
  }
  if (verifyAppSession(exchanged.session, SESSION_SECRET) !== "cloud-user-1") {
    throw new Error("exchange returned an app session that does not verify");
  }
  const sessionExchange = cloudRequests.find(
    (r) => r.path === "/api/v1/app-auth/session",
  );
  if (
    sessionExchange?.headers.authorization !== "Bearer eac_good" ||
    sessionExchange.headers["x-app-id"] !== APP_ID
  ) {
    throw new Error(
      `exchange did not call cloud with the expected headers: ${JSON.stringify(sessionExchange)}`,
    );
  }

  const history = await fetch(`${baseUrl}/api/history/`, {
    headers: { "x-app-session": exchanged.session },
  });
  if (history.status !== 200) {
    throw new Error(
      `history with a valid app session should 200, got ${history.status}`,
    );
  }

  const message = await fetch(`${baseUrl}/api/messages/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-app-session": exchanged.session,
    },
    body: JSON.stringify({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }),
  });
  if (message.status !== 200) {
    throw new Error(
      `message with a valid app session should 200, got ${message.status}`,
    );
  }
  const reply = (await message.json()) as {
    content?: Array<{ text?: string }>;
  };
  if (reply.content?.[0]?.text !== "fake cloud reply") {
    throw new Error(`unexpected message reply: ${JSON.stringify(reply)}`);
  }
  const upstreamMessage = cloudRequests.find(
    (r) => r.path === "/api/v1/messages",
  );
  if (
    upstreamMessage?.headers.authorization !== `Bearer ${OWNER_KEY}` ||
    upstreamMessage.headers["x-app-id"] !== APP_ID ||
    upstreamMessage.headers["x-affiliate-code"] !== AFFILIATE_CODE
  ) {
    throw new Error(
      `message did not proxy with owner/app/affiliate headers: ${JSON.stringify(upstreamMessage)}`,
    );
  }

  // ── Misconfiguration: a session secret alone must not enable sign-in ───────
  const misconfiguredPort = port + 1;
  const misconfiguredBaseUrl = `http://127.0.0.1:${misconfiguredPort}`;
  const misconfigured = Bun.spawn(["bun", "run", "server.ts"], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      ELIZA_AFFILIATE_CODE: AFFILIATE_CODE,
      ELIZA_APP_ID: APP_ID,
      ELIZA_CLOUD_API_KEY: "",
      ELIZA_CLOUD_URL: cloudBaseUrl,
      ELIZAOS_CLOUD_API_KEY: "",
      EDAD_SESSION_SECRET: SESSION_SECRET,
      PORT: String(misconfiguredPort),
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const misconfiguredReaders = [
    collect(misconfigured.stdout).catch(() => {}),
    collect(misconfigured.stderr).catch(() => {}),
  ];
  try {
    const misconfiguredStarted = Date.now();
    let misconfiguredReady = false;
    while (!misconfiguredReady && Date.now() - misconfiguredStarted < 10_000) {
      try {
        const health = await fetch(`${misconfiguredBaseUrl}/health`);
        misconfiguredReady =
          health.status === 200 && (await health.text()) === "ok";
      } catch {
        await Bun.sleep(100);
      }
    }
    if (!misconfiguredReady) {
      throw new Error(
        `misconfigured eDad server did not start on ${misconfiguredBaseUrl}\n${output}`,
      );
    }
    const noOwnerKey = await fetch(
      `${misconfiguredBaseUrl}/api/auth/exchange`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "eac_test" }),
      },
    );
    if (noOwnerKey.status !== 500) {
      throw new Error(
        `exchange without an owner Cloud key should 500, got ${noOwnerKey.status}`,
      );
    }
  } finally {
    misconfigured.kill();
    await misconfigured.exited.catch(() => {});
    await Promise.all(misconfiguredReaders);
  }

  console.log("eDad local smoke test passed");
} finally {
  proc.kill();
  await proc.exited.catch(() => {});
  await Promise.all(outputReaders);
  fakeCloud.stop(true);
}
