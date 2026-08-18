/**
 * Exercises the ACP credential and PATH bootstrap in an isolated Bun process
 * so process-global authority state cannot leak between test cases.
 */
import { expect, it } from "bun:test";

it("deletes the warm token before imports and captures only claimed PATH", () => {
  const bootstrapUrl = new URL("./acp-bootstrap.ts", import.meta.url).href;
  const sharedUrl = new URL(
    "../../../shared/src/host-execution-env.ts",
    import.meta.url,
  ).href;
  const script = `
    const bootstrap = await import(${JSON.stringify(bootstrapUrl)});
    const shared = await import(${JSON.stringify(sharedUrl)});
    const before = {
      exposed: process.env.ELIZA_ACP_WARM_CLAIM_TOKEN,
      token: bootstrap.consumeWarmClaimToken(),
      baseline: shared.getHostExecutionBaseline().path,
    };
    process.env.PATH = "/claimed/wrapper:/usr/bin";
    shared.captureHostExecutionBaseline();
    process.stdout.write(JSON.stringify({
      before,
      after: shared.getHostExecutionBaseline().path,
    }));
  `;
  const result = Bun.spawnSync(
    [process.execPath, "--conditions=eliza-source", "-e", script],
    {
      env: {
        ...process.env,
        ELIZA_ACP_WARM_CLAIM_TOKEN: "single-use-secret",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({
    before: { token: "single-use-secret" },
    after: "/claimed/wrapper:/usr/bin",
  });
});
