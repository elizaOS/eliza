#!/usr/bin/env node
/**
 * Proves PostgreSQL 16 base-backup and WAL recovery in private temporary clusters.
 * It never connects to an existing database or cloud repository. Logs and the
 * encrypted local repository remain in the reported directory for inspection;
 * only clusters created by this invocation are stopped during teardown.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const drillRoot = mkdtempSync("/tmp/eliza-tenant-pitr-");
const source = join(drillRoot, "source");
const restored = join(drillRoot, "restored");
const sourceSocket = join(drillRoot, "socket-source");
const restoredSocket = join(drillRoot, "socket-restored");
const config = join(drillRoot, "pgbackrest.conf");
const logPath = join(drillRoot, "commands.log");
const reportPath = join(drillRoot, "report.json");
const configIncludes = join(drillRoot, "config.d");
// Existing database/service settings must never redirect this fixture drill.
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("PG")),
);
const started = new Set();
const pg = (name) =>
  process.env.PG_BIN ? join(process.env.PG_BIN, name) : name;
const backrest = process.env.PGBACKREST_BIN || "pgbackrest";
const pgQuote = (value) =>
  `'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
let transcript = "";
function run(command, args, timeout = 120_000) {
  transcript += `$ ${command} ${args.join(" ")}\n`;
  try {
    const output = execFileSync(command, args, {
      encoding: "utf8",
      env: childEnv,
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
    });
    transcript += `${output}\n`;
    return output.trim();
  } catch (error) {
    // error-policy:J2 preserve the failing external command and its diagnostic output.
    transcript += String(error.stdout || "") + String(error.stderr || "");
    throw new Error(`Recovery drill command failed: ${command}`, {
      cause: error,
    });
  } finally {
    writeFileSync(logPath, transcript, { mode: 0o600 });
  }
}
function sql(socket, statement) {
  return run(pg("psql"), [
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "-h",
    socket,
    "-p",
    "55439",
    "-U",
    "drill_admin",
    "-d",
    "postgres",
    "-Atc",
    statement,
  ]);
}
function start(path, socket) {
  started.add(path);
  run(pg("pg_ctl"), [
    "-D",
    path,
    "-l",
    join(drillRoot, `${path === source ? "source" : "restored"}.log`),
    "-o",
    `-c listen_addresses= -c unix_socket_directories=${socket} -p 55439 -c archive_mode=${path === source ? "on" : "off"}`,
    "-w",
    "start",
  ]);
}
const report = {
  schemaVersion: 1,
  status: "running",
  drillRoot,
  scope: "local-postgresql16-encrypted-repository",
  startedAt: new Date().toISOString(),
};
console.log(`Recovery drill artifacts: ${drillRoot}`);
try {
  report.postgresVersion = run(pg("postgres"), ["--version"]);
  if (!/PostgreSQL\) 16\./.test(report.postgresVersion))
    throw new Error(
      "Drill requires PostgreSQL 16; set PG_BIN to its binary directory",
    );
  report.pgbackrestVersion = run(backrest, ["version"]);
  for (const dir of [
    sourceSocket,
    restoredSocket,
    configIncludes,
    join(drillRoot, "repository"),
    join(drillRoot, "locks"),
  ])
    mkdirSync(dir, { mode: 0o700 });
  writeFileSync(
    config,
    `[tenant]\npg1-path=${source}\npg1-socket-path=${sourceSocket}\npg1-port=55439\npg1-user=drill_admin\n[global]\nrepo1-type=posix\nrepo1-path=${drillRoot}/repository\nrepo1-cipher-type=aes-256-cbc\nrepo1-cipher-pass=${randomBytes(32).toString("hex")}\nrepo1-retention-full=2\nlock-path=${drillRoot}/locks\nlog-level-file=off\nlog-level-console=info\nstart-fast=y\narchive-timeout=60\n`,
    { mode: 0o600 },
  );
  run(pg("initdb"), [
    "-D",
    source,
    "-U",
    "drill_admin",
    "--auth-local=trust",
    "--auth-host=reject",
    "--no-locale",
    "--encoding=UTF8",
  ]);
  const archive = `${shellQuote(backrest)} --config=${shellQuote(config)} --config-include-path=${shellQuote(configIncludes)} --stanza=tenant archive-push "%p"`;
  const sourceConf = join(source, "postgresql.conf");
  writeFileSync(
    sourceConf,
    readFileSync(sourceConf, "utf8") +
      `\narchive_mode=on\narchive_command=${pgQuote(archive)}\narchive_timeout=60\nwal_level=replica\n`,
  );
  start(source, sourceSocket);
  const backup = (...args) =>
    run(backrest, [
      `--config=${config}`,
      `--config-include-path=${configIncludes}`,
      "--stanza=tenant",
      ...args,
    ]);
  backup("stanza-create");
  backup("check");
  sql(
    sourceSocket,
    "CREATE TABLE recovery_fixture (id integer PRIMARY KEY, value text NOT NULL); INSERT INTO recovery_fixture VALUES (1, 'base-backup-value');",
  );
  backup("--type=full", "backup");
  sql(
    sourceSocket,
    "UPDATE recovery_fixture SET value='wal-recovered-value' WHERE id=1; INSERT INTO recovery_fixture VALUES (2, 'created-after-backup');",
  );
  report.restorePointLsn = sql(
    sourceSocket,
    "SELECT pg_create_restore_point('before_fixture_loss');",
  );
  sql(sourceSocket, "DELETE FROM recovery_fixture;");
  if (sql(sourceSocket, "SELECT count(*) FROM recovery_fixture;") !== "0")
    throw new Error("Fixture deletion was not observed on the source");
  backup("check");
  const restoreStarted = Date.now();
  backup(
    `--pg1-path=${restored}`,
    "--type=name",
    "--target=before_fixture_loss",
    "--target-action=promote",
    "restore",
  );
  start(restored, restoredSocket);
  const recoveryDeadline = Date.now() + 60_000;
  while (sql(restoredSocket, "SELECT pg_is_in_recovery();") !== "f") {
    if (Date.now() >= recoveryDeadline)
      throw new Error("Restored cluster did not reach its recovery target");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const recovered = JSON.parse(
    sql(
      restoredSocket,
      "SELECT json_agg(recovery_fixture ORDER BY id) FROM recovery_fixture;",
    ),
  );
  const expected = [
    { id: 1, value: "wal-recovered-value" },
    { id: 2, value: "created-after-backup" },
  ];
  if (JSON.stringify(recovered) !== JSON.stringify(expected))
    throw new Error(
      "Recovery did not reproduce the post-backup, pre-loss rows",
    );
  if (sql(sourceSocket, "SELECT count(*) FROM recovery_fixture;") !== "0")
    throw new Error("Recovery unexpectedly modified the source cluster");
  report.recoveredRows = recovered;
  report.restoreElapsedMs = Date.now() - restoreStarted;
  // Preserve PostgreSQL's 64-bit system identifier without JavaScript number rounding.
  report.repositoryInfoPath = join(drillRoot, "repository-info.json");
  writeFileSync(
    report.repositoryInfoPath,
    `${backup("--output=json", "info")}\n`,
    { mode: 0o600 },
  );
  report.status = "passed";
} catch (error) {
  // error-policy:J1 the CLI emits a failed report and nonzero exit without fabricating recovery evidence.
  report.status = "failed";
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  for (const path of [...started].reverse()) {
    if (!existsSync(join(path, "postmaster.pid"))) continue;
    try {
      run(pg("pg_ctl"), ["-D", path, "-m", "fast", "-w", "stop"]);
    } catch (error) {
      // error-policy:J6 preserve owned-cluster teardown failures in the drill result.
      report.status = "failed";
      report.teardownError =
        error instanceof Error ? error.message : String(error);
      process.exitCode = 1;
    }
  }
  report.finishedAt = new Date().toISOString();
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      status: report.status,
      reportPath,
      restoreElapsedMs: report.restoreElapsedMs,
    }),
  );
}
