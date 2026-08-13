#!/usr/bin/env node
/**
 * Runs the bundled cloud API in local workerd with explicit private-network egress.
 * This is reserved for OrbStack parity, where the Worker must reach local agents.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "../../../../..");
const cloudApiDir = path.join(repoRoot, "packages", "cloud", "api");
const require = createRequire(import.meta.url);

export function parsePrivateNetworkWorkerArgs(args) {
  const valueAfter = (flag, fallback) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : fallback;
  };
  return {
    env: valueAfter("--env", process.env.ELIZA_CLOUD_LOCAL_PROFILE),
    host: valueAfter("--ip", "127.0.0.1"),
    port: Number.parseInt(
      valueAfter("--port", process.env.API_DEV_PORT ?? "8787"),
      10,
    ),
    persistPath: path.resolve(
      valueAfter(
        "--persist-to",
        path.join(repoRoot, ".eliza", "local-parity", "workerd"),
      ),
    ),
  };
}

function assertLocalPrivateNetworkMode(options) {
  if (
    process.env.ENVIRONMENT !== "local" ||
    process.env.ELIZA_LOCAL_DOCKER_PROVIDER !== "1" ||
    process.env.ELIZA_WORKER_ALLOW_PRIVATE_NETWORK !== "1"
  ) {
    throw new Error(
      "Private-network workerd requires ENVIRONMENT=local, " +
        "ELIZA_LOCAL_DOCKER_PROVIDER=1, and ELIZA_WORKER_ALLOW_PRIVATE_NETWORK=1",
    );
  }
  if (options.env !== "staging" && options.env !== "production") {
    throw new Error(
      `Private-network workerd requires a local staging or production profile`,
    );
  }
  if (options.host !== "127.0.0.1") {
    throw new Error("Private-network workerd must listen on 127.0.0.1");
  }
  if (
    !Number.isInteger(options.port) ||
    options.port < 1024 ||
    options.port > 65535
  ) {
    throw new Error(`Invalid private-network workerd port: ${options.port}`);
  }
}

function buildWorkerBundle(profile, bundleDir) {
  const result = spawnSync(
    process.execPath,
    [
      "run",
      "wrangler",
      "deploy",
      "--env",
      profile,
      "--dry-run",
      "--outdir",
      bundleDir,
    ],
    { cwd: cloudApiDir, env: process.env, stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(
      `wrangler dry-run bundle failed (${result.status ?? "signal"})`,
    );
  }
}

async function main() {
  const options = parsePrivateNetworkWorkerArgs(process.argv.slice(2));
  assertLocalPrivateNetworkMode(options);

  const bundleDir = `${options.persistPath}-bundle`;
  buildWorkerBundle(options.env, bundleDir);

  process.chdir(cloudApiDir);
  const miniflarePath = require.resolve("miniflare", {
    paths: [cloudApiDir, repoRoot],
  });
  const wranglerPath = require.resolve("wrangler", {
    paths: [cloudApiDir, repoRoot],
  });
  const [
    { Miniflare },
    { unstable_getMiniflareWorkerOptions, unstable_readConfig },
  ] = await Promise.all([
    import(pathToFileURL(miniflarePath).href),
    import(pathToFileURL(wranglerPath).href),
  ]);
  const config = await unstable_readConfig({
    config: "wrangler.toml",
    env: options.env,
  });
  const worker = unstable_getMiniflareWorkerOptions(
    "wrangler.toml",
    options.env,
  );
  const workerOptions = Object.fromEntries(
    Object.entries(worker.workerOptions).filter(
      ([, value]) => value !== undefined,
    ),
  );
  const bundlePath = path.join(bundleDir, "index.js");
  const miniflare = new Miniflare({
    host: options.host,
    port: options.port,
    defaultPersistRoot: options.persistPath,
    workers: [
      {
        name: config.name,
        ...workerOptions,
        modules: [
          {
            type: "ESModule",
            path: "index.js",
            contents: readFileSync(bundlePath, "utf8"),
          },
          {
            type: "ESModule",
            path: "@node-rs/xxhash",
            contents:
              'throw new Error("@node-rs/xxhash is unavailable in workerd");',
          },
        ],
        // workerd defaults to public-only global fetch. This local-only process
        // needs private egress for OrbStack agent DNS and loopback mocks.
        outboundService: {
          network: {
            allow: ["public", "private"],
            tlsOptions: { trustBrowserCas: true },
          },
        },
      },
      ...worker.externalWorkers,
    ],
  });

  await miniflare.ready;
  console.log(
    `[workerd-private-network-dev] ready profile=${options.env} url=http://${options.host}:${options.port}`,
  );

  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await miniflare.dispose();
}

if (import.meta.main) {
  // error-policy:J1 the process boundary reports startup/runtime failure and exits non-zero.
  main().catch((error) => {
    console.error(
      `[workerd-private-network-dev] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
