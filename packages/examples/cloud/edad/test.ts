const port = 30_000 + Math.floor(Math.random() * 10_000);
const baseUrl = `http://127.0.0.1:${port}`;

const SESSION_SECRET = "test-session-secret";

const proc = Bun.spawn(["bun", "run", "server.ts"], {
  cwd: import.meta.dir,
  env: {
    ...process.env,
    ELIZA_AFFILIATE_CODE: "AFF-TEST",
    ELIZA_APP_ID: "00000000-0000-4000-8000-000000000000",
    ELIZA_CLOUD_URL: "https://elizacloud.ai",
    ELIZAOS_CLOUD_API_KEY: "eliza_test_owner_key",
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
    body.affiliate_code !== "AFF-TEST" ||
    body.app_id !== "00000000-0000-4000-8000-000000000000" ||
    body.cloud_url !== "https://elizacloud.ai"
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

  // ── Misconfiguration: a session secret alone must not enable sign-in ───────
  const misconfiguredPort = port + 1;
  const misconfiguredBaseUrl = `http://127.0.0.1:${misconfiguredPort}`;
  const misconfigured = Bun.spawn(["bun", "run", "server.ts"], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      ELIZA_AFFILIATE_CODE: "AFF-TEST",
      ELIZA_APP_ID: "00000000-0000-4000-8000-000000000000",
      ELIZA_CLOUD_API_KEY: "",
      ELIZA_CLOUD_URL: "https://elizacloud.ai",
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
}
