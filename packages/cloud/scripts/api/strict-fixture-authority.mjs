import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";

export function validateStrictFixtureAuthority(value, expected) {
  if (
    !value ||
    value.version !== 1 ||
    value.kind !== "job-owned-postgres" ||
    !expected.runId ||
    !expected.job ||
    !expected.attempt ||
    value.runId !== expected.runId ||
    value.job !== expected.job ||
    value.attempt !== expected.attempt ||
    value.databaseUrl !== expected.databaseUrl ||
    value.databaseUrl !== "postgresql://postgres@127.0.0.1:5432/postgres" ||
    value.containerName !== "eliza-cloud-test-postgres" ||
    !/^[a-f0-9]{64}$/.test(value.containerId ?? "") ||
    !Number.isFinite(value.createdAt) ||
    value.createdAt > expected.now ||
    expected.now - value.createdAt > 3600000
  )
    throw new Error("Group D fixture database authority mismatch");
  return value;
}

export function ownedPostgresFixtureAuthority(env = process.env) {
  const path = env.CLOUD_E2E_DATABASE_AUTHORITY;
  if (!path) return null;
  if (!env.RUNNER_TEMP) throw new Error("Missing owner receipt directory");
  const root = realpathSync(env.RUNNER_TEMP),
    actual = realpathSync(path),
    rel = relative(root, actual);
  if (
    !rel ||
    rel.startsWith("..") ||
    isAbsolute(rel) ||
    actual !== resolve(path)
  )
    throw new Error("Invalid database authority receipt path");
  const stat = lstatSync(actual);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.size > 4096 ||
    stat.mode & 0o077 ||
    stat.uid !== process.getuid()
  )
    throw new Error("Invalid database authority receipt metadata");
  const value = validateStrictFixtureAuthority(
    JSON.parse(readFileSync(actual, "utf8")),
    {
      runId: env.GITHUB_RUN_ID,
      job: env.GITHUB_JOB,
      attempt: env.GITHUB_RUN_ATTEMPT,
      databaseUrl: env.TEST_DATABASE_URL || env.DATABASE_URL,
      now: Date.now(),
    },
  );
  if (env.DOCKER_HOST && !env.DOCKER_HOST.startsWith("unix://"))
    throw new Error("Remote Docker endpoint refused");
  const endpoint = JSON.parse(
    execFileSync(
      "docker",
      ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"],
      {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 4096,
      },
    ),
  );
  if (
    typeof endpoint !== "string" ||
    !endpoint.startsWith("unix://") ||
    (env.DOCKER_HOST && env.DOCKER_HOST !== endpoint)
  )
    throw new Error("Remote Docker context refused");
  const state = JSON.parse(
    execFileSync(
      "docker",
      ["inspect", "--format", "{{json .}}", value.containerId],
      {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 65536,
      },
    ),
  );
  const ports = state.NetworkSettings?.Ports?.["5432/tcp"];
  if (
    state.Id !== value.containerId ||
    state.Name !== "/" + value.containerName ||
    !state.State?.Running ||
    state.Config?.Image !== "pgvector/pgvector:pg16" ||
    state.Config?.Labels?.["eliza.e2e.run"] !== value.runId ||
    state.Config?.Labels?.["eliza.e2e.job"] !== value.job ||
    state.Config?.Labels?.["eliza.e2e.attempt"] !== value.attempt ||
    !ports?.some(
      (p) =>
        p.HostPort === "5432" && ["127.0.0.1", "0.0.0.0"].includes(p.HostIp),
    )
  )
    throw new Error("Owned PostgreSQL container changed");
  return value;
}
