/** Fresh read-only CLI/audit capture. Raw output and connection details never leave this boundary. */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCanonicalRailwayTarget } from "./audit-production-railway-database-authority";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** Internal bounded read process; no shell, stdin, inherited secrets or raw diagnostics. */
async function readCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  allowAuditFailure = false,
): Promise<unknown> {
  if (signal.aborted) throw Error("stage_authority_unavailable");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let done = false,
      stopped = false,
      bytes = 0;
    const chunks: Buffer[] = [];
    const present = () => {
      if (!child.pid) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code !== "ESRCH";
      }
    };
    const finish = (value?: unknown, failed = true) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      failed ? reject(Error("stage_authority_unavailable")) : resolve(value);
    };
    const stop = () => {
      if (done) return;
      stopped = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* verify on close */
      }
    };
    const timer = setTimeout(stop, 60000);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    child.stdout.on("data", (b: Buffer) => {
      bytes += b.length;
      if (bytes > 4 * 1024 * 1024) stop();
      else chunks.push(b);
    });
    child.stderr.on("data", (b: Buffer) => {
      bytes += b.length;
      if (bytes > 4 * 1024 * 1024) stop();
    });
    child.on("error", () => finish());
    child.on("close", async (code) => {
      const descendants = present();
      if (descendants) {
        stop();
        const deadline = Date.now() + 5000;
        while (present() && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 20));
      }
      if (
        descendants ||
        present() ||
        stopped ||
        !(code === 0 || (allowAuditFailure && code === 1))
      )
        return finish();
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString("utf8")), false);
      } catch {
        finish();
      }
    });
  });
}
export interface StageAuthorityInput {
  projectId: string;
  environmentId: string;
  serviceId: string;
  signal: AbortSignal;
}
/** Protected workflow must install pinned Railway5.38/Bun1.4.2 and freeze canonical source first. */
export async function refreshStageAuthority(input: StageAuthorityInput) {
  let directory: string | undefined;
  let failure = false;
  let result:
    | { authority: unknown; authorityObservedAtMs: number; pitr: unknown }
    | undefined;
  try {
    if (
      ![input.projectId, input.environmentId, input.serviceId].every((v) =>
        UUID.test(v),
      ) ||
      !process.env.RAILWAY_TOKEN ||
      !process.env.DATABASE_URL
    )
      throw Error();
    const started = Date.now();
    const siblings = new AbortController();
    const signal = AbortSignal.any([input.signal, siblings.signal]);
    directory = mkdtempSync(join(tmpdir(), "pitr-stage-authority-"));
    const env = {
      PATH: process.env.PATH,
      CI: "true",
      NO_COLOR: "1",
      RAILWAY_TOKEN: process.env.RAILWAY_TOKEN,
    };
    const common = [
      "--project",
      input.projectId,
      "--environment",
      input.environmentId,
    ];
    const results = await Promise.allSettled(
      [
        readCommand("railway", ["status", ...common, "--json"], env, signal),
        readCommand(
          "railway",
          ["service", "list", ...common, "--json"],
          env,
          signal,
        ),
        readCommand(
          "railway",
          [
            "variable",
            "list",
            ...common,
            "--service",
            input.serviceId,
            "--json",
          ],
          env,
          signal,
        ),
        readCommand(
          "railway",
          [
            "postgres",
            "pitr",
            "status",
            ...common,
            "--service",
            input.serviceId,
            "--json",
          ],
          env,
          signal,
        ),
      ].map((p) =>
        p.catch((error) => {
          siblings.abort();
          throw error;
        }),
      ),
    );
    if (results.some((r) => r.status !== "fulfilled")) throw Error();
    const [status, services, variables, pitr] = results.map(
      (r) => (r as PromiseFulfilledResult<unknown>).value,
    );
    if (
      !status ||
      typeof status !== "object" ||
      Array.isArray(status) ||
      !Array.isArray(services) ||
      !variables ||
      typeof variables !== "object" ||
      Array.isArray(variables)
    )
      throw Error();
    const evidence = { status, services, variables } as Parameters<
      typeof resolveCanonicalRailwayTarget
    >[0];
    const resolution = resolveCanonicalRailwayTarget(evidence, {
      projectId: input.projectId,
      environmentId: input.environmentId,
      serviceId: input.serviceId,
    });
    if (
      resolution.verdict !== "match" ||
      resolution.serviceId !== input.serviceId
    )
      throw Error();
    const paths = Object.fromEntries(
      ["status", "services", "variables", "resolved-service-id"].map((n) => [
        n,
        join(directory as string, n),
      ]),
    );
    for (const [name, value] of Object.entries({ status, services, variables }))
      writeFileSync(paths[name], JSON.stringify(value), {
        flag: "wx",
        mode: 0o600,
      });
    writeFileSync(paths["resolved-service-id"], input.serviceId, {
      flag: "wx",
      mode: 0o600,
    });
    const authority = await readCommand(
      "bun",
      [
        "--no-env-file",
        "packages/cloud/scripts/admin/audit-production-railway-database-authority.ts",
        "--status-json",
        paths.status,
        "--services-json",
        paths.services,
        "--variables-json",
        paths.variables,
        "--resolved-service-id-file",
        paths["resolved-service-id"],
      ],
      {
        PATH: process.env.PATH,
        DATABASE_URL: process.env.DATABASE_URL,
        RAILWAY_PROJECT_ID: input.projectId,
        RAILWAY_ENVIRONMENT_ID: input.environmentId,
        RAILWAY_POSTGRES_SERVICE_ID: input.serviceId,
        CI: "true",
        NO_COLOR: "1",
      },
      input.signal,
      true,
    );
    if (Date.now() < started || Date.now() - started > 60000) throw Error();
    result = { authority, authorityObservedAtMs: started, pitr };
  } catch {
    failure = true;
  } finally {
    if (directory) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        failure = true;
      }
    }
  }
  if (failure || !result) throw Error("stage_authority_unavailable");
  return result;
}
