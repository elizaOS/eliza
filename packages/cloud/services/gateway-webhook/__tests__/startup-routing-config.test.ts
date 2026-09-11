/** Verifies the real gateway process rejects unsafe routing configuration before binding its health server. */
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

describe("gateway startup routing configuration", () => {
  test("exits before serving when the canonical routing pair is absent", async () => {
    const env = {
      ...process.env,
      ELIZA_CLOUD_URL: "https://api.example.invalid",
      GATEWAY_BOOTSTRAP_SECRET: "startup-test-secret",
      MOCK_REDIS: "1",
    };
    delete env.AGENT_ROUTER_ORIGIN_HOST;
    delete env.ELIZA_CLOUD_AGENT_BASE_DOMAIN;

    const child = Bun.spawn([process.execPath, "run", "src/index.ts"], {
      cwd: packageRoot,
      env,
      stdout: "pipe",
      stderr: "pipe",
      // Source startup is not a five-second latency contract. Keep the child
      // bounded while reserving time for pipe draining and teardown.
      timeout: 20_000,
      killSignal: "SIGKILL",
    });
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const output = `${stdout}\n${stderr}`;

      expect(child.signalCode, output).toBeNull();
      expect(exitCode, output).toBe(1);
      expect(output).toContain(
        "must be configured as an exact canonical production or staging pair",
      );
      expect(output).not.toContain("Webhook gateway listening");
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
  }, 30_000);
});
