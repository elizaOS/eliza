const port = 30_000 + Math.floor(Math.random() * 10_000);
const baseUrl = `http://127.0.0.1:${port}`;

const proc = Bun.spawn(["bun", "run", "server.ts"], {
  cwd: import.meta.dir,
  env: {
    ...process.env,
    ELIZA_AFFILIATE_CODE: "AFF-TEST",
    ELIZA_APP_ID: "00000000-0000-4000-8000-000000000000",
    ELIZA_CLOUD_URL: "https://www.elizacloud.ai",
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
    body.cloud_url !== "https://www.elizacloud.ai"
  ) {
    throw new Error(`Unexpected config body: ${JSON.stringify(body)}`);
  }

  console.log("eDad local smoke test passed");
} finally {
  proc.kill();
  await proc.exited.catch(() => {});
  await Promise.all(outputReaders);
}
