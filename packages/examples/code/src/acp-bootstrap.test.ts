/**
 * Exercises the ACP credential and PATH bootstrap in an isolated Bun process
 * so process-global authority state cannot leak between test cases.
 */
import { expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_EXECUTION_BASELINE_ENV_MIRROR_KEYS } from "@elizaos/shared/host-execution-env";

function cleanHostAuthorityEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const denied = new Set([
    "GOPATH",
    "GOMODCACHE",
    "GOCACHE",
    ...HOST_EXECUTION_BASELINE_ENV_MIRROR_KEYS,
  ]);
  for (const key of Object.keys(env)) {
    if (denied.has(key.toUpperCase())) delete env[key];
  }
  return env;
}

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
  const childEnv: NodeJS.ProcessEnv = {
    ...cleanHostAuthorityEnv(),
    ELIZA_ACP_WARM_CLAIM_TOKEN: "single-use-secret",
  };
  const result = Bun.spawnSync(
    [process.execPath, "--conditions=eliza-source", "-e", script],
    {
      env: childEnv,
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

it("cold bootstrap captures only parent-canonical Go authority", () => {
  const bootstrapUrl = new URL("./acp-bootstrap.ts", import.meta.url).href;
  const sharedUrl = new URL(
    "../../../shared/src/host-execution-env.ts",
    import.meta.url,
  ).href;
  const script = `
    await import(${JSON.stringify(bootstrapUrl)});
    const shared = await import(${JSON.stringify(sharedUrl)});
    process.stdout.write(JSON.stringify(shared.getHostExecutionBaseline()));
  `;
  const goPath = join(tmpdir(), "parent-go");
  const goModCache = join(tmpdir(), "parent-go-mod");
  const goCache = join(tmpdir(), "parent-go-build");
  const childEnv: NodeJS.ProcessEnv = {
    ...cleanHostAuthorityEnv(),
    HOME: join(tmpdir(), "caller-home-must-not-win"),
    GOPATH: goPath,
    GOMODCACHE: goModCache,
    GOCACHE: goCache,
    ELIZA_HOST_EXECUTION_BASELINE_GOPATH: join(tmpdir(), "caller-mirror"),
  };
  delete childEnv.ELIZA_ACP_WARM_CLAIM_TOKEN;
  const result = Bun.spawnSync(
    [process.execPath, "--conditions=eliza-source", "-e", script],
    { env: childEnv, stdout: "pipe", stderr: "pipe" },
  );

  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({
    goPath,
    goModCache,
    goCache,
  });
});

it("warm bootstrap captures authenticated Go authority over bootstrap values", () => {
  const bootstrapUrl = new URL("./acp-bootstrap.ts", import.meta.url).href;
  const claimUrl = new URL("./acp-session-claim.ts", import.meta.url).href;
  const sharedUrl = new URL(
    "../../../shared/src/host-execution-env.ts",
    import.meta.url,
  ).href;
  const goPath = join(tmpdir(), "claimed-go");
  const goModCache = join(tmpdir(), "claimed-go-mod");
  const goCache = join(tmpdir(), "claimed-go-build");
  const executionPath =
    process.platform === "win32" ? "C:\\Windows\\System32" : "/usr/bin:/bin";
  const script = `
    const bootstrap = await import(${JSON.stringify(bootstrapUrl)});
    const { AcpWarmSessionClaim } = await import(${JSON.stringify(claimUrl)});
    const shared = await import(${JSON.stringify(sharedUrl)});
    const claim = new AcpWarmSessionClaim(bootstrap.consumeWarmClaimToken());
    claim.apply({ elizaSessionClaim: {
      token: "single-use-secret",
      env: ${JSON.stringify({ GOPATH: goPath, GOMODCACHE: goModCache, GOCACHE: goCache })},
      executionPath: ${JSON.stringify(executionPath)}
    }});
    const baseline = shared.captureHostExecutionBaseline();
    const applied = shared.applyHostExecutionBaseline({
      PATH: "/caller/bin",
      GOPATH: "/caller/go",
      GOMODCACHE: "/caller/mod",
      GOCACHE: "/caller/build"
    });
    process.stdout.write(JSON.stringify({ baseline, applied }));
  `;
  const childEnv = {
    ...cleanHostAuthorityEnv(),
    ELIZA_ACP_WARM_CLAIM_TOKEN: "single-use-secret",
    HOME: join(tmpdir(), "bootstrap-home-must-not-win"),
    GOPATH: join(tmpdir(), "bootstrap-go-must-not-win"),
    GOMODCACHE: join(tmpdir(), "bootstrap-mod-must-not-win"),
    GOCACHE: join(tmpdir(), "bootstrap-build-must-not-win"),
  };
  const result = Bun.spawnSync(
    [process.execPath, "--conditions=eliza-source", "-e", script],
    { env: childEnv, stdout: "pipe", stderr: "pipe" },
  );

  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const parsed = JSON.parse(result.stdout.toString()) as {
    baseline: Record<string, string>;
    applied: Record<string, string>;
  };
  expect(parsed.baseline).toMatchObject({ goPath, goModCache, goCache });
  expect(parsed.applied).toMatchObject({
    GOPATH: goPath,
    GOMODCACHE: goModCache,
    GOCACHE: goCache,
  });
});
