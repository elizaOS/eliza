const proc = Bun.spawn(["bun", "run", "server.ts"], {
  cwd: import.meta.dir,
  env: {
    ...process.env,
    ELIZA_AFFILIATE_CODE: "AFF-TEST",
    ELIZA_APP_ID: "00000000-0000-4000-8000-000000000000",
    ELIZA_CLOUD_URL: "https://www.elizacloud.ai",
    PORT: "0",
  },
  stderr: "pipe",
  stdout: "pipe",
});

const decoder = new TextDecoder();
let baseUrl: string | null = null;

try {
  const started = Date.now();
  let output = "";

  while (!baseUrl && Date.now() - started < 10_000) {
    const chunk = await proc.stdout.getReader().read();
    if (chunk.done) break;
    output += decoder.decode(chunk.value);
    const match = output.match(/listening on (http:\/\/[^:\s]+:\d+)/);
    if (match) baseUrl = match[1].replace("0.0.0.0", "127.0.0.1");
  }

  if (!baseUrl) {
    throw new Error("eDad smoke test server did not start");
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
}
