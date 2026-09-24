/** Starts Login from the production-only filesystem declared by its Railpack recipe. */
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../../../..");

test("Railpack runtime resolves workspace dependencies and serves health without the checkout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "login-railpack-"));
  const build = join(directory, "build");
  const runtime = join(directory, "runtime");
  await mkdir(build);
  await mkdir(runtime);
  const run = async (command: string[], cwd: string) => {
    const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
    const output = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const code = await child.exited;
    const logs = (await output).join("\n");
    if (code !== 0)
      throw new Error(`${command.join(" ")} failed (${code}):\n${logs}`);
    return logs;
  };
  let server: ReturnType<typeof Bun.spawn> | undefined;
  let logs: Promise<string[]> | undefined;
  try {
    const tracked = await run(
      ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      root,
    );
    const manifests = tracked
      .split("\0")
      .filter(
        (path) =>
          path.endsWith("package.json") && Bun.file(join(root, path)).size > 0,
      );
    const patches = tracked
      .split("\0")
      .filter(
        (path) =>
          path.endsWith(".patch") && Bun.file(join(root, path)).size > 0,
      );
    for (const path of [...manifests, ...patches, "bun.lock"]) {
      await mkdir(dirname(join(build, path)), { recursive: true });
      await cp(join(root, path), join(build, path));
    }
    for (const name of ["auth", "core", "shared"]) {
      await cp(join(root, "packages", name), join(build, "packages", name), {
        recursive: true,
        filter: (path) =>
          !/(?:^|\/)(?:node_modules|dist|\.turbo)(?:\/|$)/.test(path),
      });
    }
    const recipe = JSON.parse(
      await readFile(join(build, "packages/auth/railpack.json"), "utf8"),
    );
    for (const step of [recipe.steps.install, recipe.steps.build]) {
      for (const command of step.commands)
        await run([process.execPath, "exec", command], build);
    }
    for (const layer of recipe.deploy.inputs) {
      if (layer.step === "packages:mise") continue;
      for (const path of layer.include) {
        await mkdir(dirname(join(runtime, path)), { recursive: true });
        await cp(join(build, path), join(runtime, path), {
          recursive: true,
          verbatimSymlinks: true,
        });
      }
    }
    // A sibling build tree must not rescue broken absolute workspace links.
    await rm(build, { recursive: true, force: true });
    const reservation = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(),
    });
    const port = reservation.port;
    await reservation.stop(true);
    server = Bun.spawn(
      [
        process.execPath,
        "--conditions=eliza-source",
        "packages/auth/src/server/embedded.ts",
      ],
      {
        cwd: runtime,
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          PORT: String(port),
          STEWARD_RUNTIME: "bun",
          STEWARD_DB_MODE: "pglite",
          STEWARD_PGLITE_MEMORY: "true",
          STEWARD_ACK_LOCAL_CUSTODY: "true",
          STEWARD_MASTER_PASSWORD: randomBytes(32).toString("hex"),
          STEWARD_JWT_SECRET: randomBytes(32).toString("hex"),
          STEWARD_KDF_SALT: randomBytes(32).toString("hex"),
          STEWARD_AUDIT_HMAC_KEY: randomBytes(32).toString("hex"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    logs = Promise.all([
      new Response(server.stdout).text(),
      new Response(server.stderr).text(),
    ]);
    let health: unknown;
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline && server.exitCode === null) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        if (response.ok) {
          health = await response.json();
          break;
        }
      } catch {
        // error-policy:J4 the child has not opened its listener yet.
      }
      await Bun.sleep(50);
    }
    if (!health) {
      server.kill("SIGKILL");
      await server.exited;
      throw new Error(
        `Packaged Login did not become healthy:\n${(await logs).join("\n")}`,
      );
    }
    expect(health).toEqual({ status: "ok", name: "@elizaos/auth" });
    server.kill("SIGTERM");
    const timeout = setTimeout(() => server?.kill("SIGKILL"), 5_000);
    try {
      expect(await server.exited).toBe(0);
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    if (server?.exitCode === null) {
      server.kill("SIGKILL");
      await server.exited;
    }
    if (logs) await logs;
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
