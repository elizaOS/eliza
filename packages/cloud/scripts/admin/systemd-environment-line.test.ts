/** Exercises canonical serialization, closed CLI checks, and atomic host-file replacement. */

import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  lookupSystemdEnvironmentValue,
  reconcileSystemdEnvironmentFile,
  serializeSystemdEnvironmentLine,
} from "./systemd-environment-line.mjs";

const serializer = path.join(import.meta.dir, "systemd-environment-line.mjs");
const backupService = path.join(
  import.meta.dir,
  "eliza-backup-catalog-worker.service",
);
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "systemd-env-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function runSerialize(name: string, value: string | Uint8Array) {
  return Bun.spawnSync([process.execPath, serializer, "serialize", name], {
    stdin: typeof value === "string" ? Buffer.from(value) : value,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function runClosedCheck(
  command: "equals" | "nonempty",
  targetPath: string,
  names: readonly string[],
  stdin = "",
) {
  return Bun.spawnSync(
    [process.execPath, serializer, command, targetPath, ...names],
    {
      stdin: Buffer.from(stdin),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

function writePlan(
  directory: string,
  names: readonly string[],
  assignments: Readonly<Record<string, string>>,
) {
  const namesPath = path.join(directory, "names");
  const assignmentsPath = path.join(directory, "assignments");
  writeFileSync(namesPath, `${names.join("\n")}\n`, { mode: 0o600 });
  writeFileSync(
    assignmentsPath,
    Object.entries(assignments)
      .map(([name, value]) => serializeSystemdEnvironmentLine(name, value))
      .join(""),
    { mode: 0o600 },
  );
  return { assignmentsPath, namesPath };
}

function reconcileForTest(params: {
  assignmentsPath: string;
  beforeRename?: (candidatePath: string, attempt: number) => void;
  namesPath: string;
  preserveUnplanned?: boolean;
  targetPath: string;
}) {
  reconcileSystemdEnvironmentFile({
    targetPath: params.targetPath,
    replacementNamesPath: params.namesPath,
    assignmentsPath: params.assignmentsPath,
    preserveUnplanned: params.preserveUnplanned,
    ownerUid: process.getuid?.() ?? 0,
    ownerGid: process.getgid?.() ?? 0,
    beforeRename: params.beforeRename,
  });
}

describe("systemd EnvironmentFile serializer", () => {
  test("round-trips JSON, quotes, backslashes, spaces, hashes, and semicolons", () => {
    const value =
      '[{"id":"plugin\\\\windows # one;two","version":"1.0.0+\\"quoted\\""}]';
    const result = runSerialize("AGENT_BACKUP_RUNTIME_PLUGINS_JSON", value);
    const output = result.stdout.toString();
    expect(result.exitCode).toBe(0);
    expect(
      lookupSystemdEnvironmentValue(
        output,
        "AGENT_BACKUP_RUNTIME_PLUGINS_JSON",
      ),
    ).toBe(value);
    expect(result.stderr.toString()).toBe("");
  });

  test("keeps a secret on stdin and out of rejection diagnostics", () => {
    const sentinel = "DO_NOT_LEAK_SYSTEMD_ENV_SECRET";
    const result = runSerialize(
      "AGENT_BACKUP_STEWARD_KMS_TOKEN",
      `${sentinel}\n`,
    );
    expect(result.exitCode).toBe(78);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).not.toContain(sentinel);
    expect(result.stderr.toString()).toContain(
      "SYSTEMD_ENVIRONMENT_VALUE_INVALID",
    );
  });

  test("rejects invalid names and NUL without reflecting the value", () => {
    const result = runSerialize("invalid-name", Buffer.from("secret\0tail"));
    expect(result.exitCode).toBe(78);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).not.toContain("secret");
    expect(result.stderr.toString()).toContain(
      "SYSTEMD_ENVIRONMENT_NAME_INVALID",
    );
  });

  test("rejects invalid UTF-8 from stdin without reflecting its valid prefix", () => {
    const sentinel = "AKIA_DO_NOT_LEAK_INVALID_UTF8_PREFIX";
    const value = Buffer.concat([Buffer.from(sentinel), Buffer.from([0xff])]);
    const result = runSerialize("AUTHORITY", value);

    expect(result.exitCode).toBe(78);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain(
      "SYSTEMD_ENVIRONMENT_VALUE_INVALID",
    );
    expect(result.stderr.toString()).not.toContain(sentinel);
  });

  test("lookup decodes both canonical quoted and legacy plain assignments", () => {
    expect(
      lookupSystemdEnvironmentValue(
        'ELIZA_CLOUD_AGENT_BASE_DOMAIN="cloud-staging.eliza.app"\n',
        "ELIZA_CLOUD_AGENT_BASE_DOMAIN",
      ),
    ).toBe("cloud-staging.eliza.app");
    expect(
      lookupSystemdEnvironmentValue(
        "ELIZA_CLOUD_AGENT_BASE_DOMAIN=cloud.eliza.app\n",
        "ELIZA_CLOUD_AGENT_BASE_DOMAIN",
      ),
    ).toBe("cloud.eliza.app");
    expect(() =>
      lookupSystemdEnvironmentValue(
        "ELIZA_CLOUD_AGENT_BASE_DOMAIN=one\n  ELIZA_CLOUD_AGENT_BASE_DOMAIN \t=two\n",
        "ELIZA_CLOUD_AGENT_BASE_DOMAIN",
      ),
    ).toThrow("SYSTEMD_ENVIRONMENT_NAME_DUPLICATE");
  });

  test("does not expose an arbitrary EnvironmentFile value through the CLI", () => {
    const sentinel = "AKIA_DO_NOT_LEAK_LOOKUP_VALUE";
    const result = Bun.spawnSync(
      [process.execPath, serializer, "lookup", "AUTHORITY"],
      {
        stdin: Buffer.from(
          serializeSystemdEnvironmentLine("AUTHORITY", sentinel),
        ),
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    expect(result.exitCode).toBe(78);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain(
      "SYSTEMD_ENVIRONMENT_COMMAND_INVALID",
    );
    expect(result.stderr.toString()).not.toContain(sentinel);
  });
});

describe("atomic EnvironmentFile reconciliation", () => {
  test("preserves unrelated entries and atomically replaces every planned key", () => {
    const directory = temporaryDirectory();
    const targetPath = path.join(directory, ".env.local");
    writeFileSync(
      targetPath,
      "KEEP_ME=present\nROTATE_ME=old\nROTATE_ME=duplicate\nREMOVE_ME=stale\n",
    );
    const plan = writePlan(directory, ["ROTATE_ME", "REMOVE_ME"], {
      ROTATE_ME: 'new "quoted" value',
    });

    reconcileForTest({ targetPath, ...plan });

    const contents = readFileSync(targetPath, "utf8");
    expect(contents).toContain("KEEP_ME=present\n");
    expect(contents).not.toContain("REMOVE_ME=");
    expect(contents.match(/^ROTATE_ME=/gm)).toHaveLength(1);
    expect(lookupSystemdEnvironmentValue(contents, "ROTATE_ME")).toBe(
      'new "quoted" value',
    );
    expect(statSync(targetPath).mode & 0o777).toBe(0o600);
  });

  test("a structured failure before rename leaves the old file byte-identical", () => {
    const directory = temporaryDirectory();
    const targetPath = path.join(directory, ".env.local");
    const oldContents = "AUTHORITY=old\nKEEP=stable\n";
    writeFileSync(targetPath, oldContents);
    const plan = writePlan(directory, ["AUTHORITY"], {
      AUTHORITY: "new-secret-value",
    });

    expect(() =>
      reconcileForTest({
        targetPath,
        ...plan,
        beforeRename: (candidatePath) => {
          expect(readFileSync(candidatePath, "utf8")).toContain(
            'AUTHORITY="new-secret-value"',
          );
          throw new Error("TEST_INJECTED_BEFORE_RENAME");
        },
      }),
    ).toThrow("TEST_INJECTED_BEFORE_RENAME");

    expect(readFileSync(targetPath, "utf8")).toBe(oldContents);
    expect(
      readdirSync(directory).filter((entry) =>
        entry.startsWith("..env.local.reconcile-"),
      ),
    ).toEqual([]);
  });

  test("exact install drops stale authorities that are outside the disabled allowlist", () => {
    const directory = temporaryDirectory();
    const targetPath = path.join(directory, "backup-catalog-worker.env");
    writeFileSync(
      targetPath,
      "DATABASE_URL=must-disappear\nAGENT_BACKUP_STEWARD_KMS_TOKEN=must-disappear\n",
    );
    const plan = writePlan(
      directory,
      [
        "AGENT_BACKUP_CATALOG_RUNTIME_ENABLED",
        "AGENT_BACKUP_RPO_SCHEDULER_ENABLED",
      ],
      {
        AGENT_BACKUP_CATALOG_RUNTIME_ENABLED: "0",
        AGENT_BACKUP_RPO_SCHEDULER_ENABLED: "0",
      },
    );

    reconcileForTest({
      targetPath,
      ...plan,
      preserveUnplanned: false,
    });

    const contents = readFileSync(targetPath, "utf8");
    expect(contents).not.toContain("DATABASE_URL");
    expect(contents).not.toContain("KMS_TOKEN");
    expect(contents.split("\n").filter(Boolean)).toHaveLength(2);
  });

  test("rejects a malformed plan before creating a candidate or changing the target", () => {
    const directory = temporaryDirectory();
    const targetPath = path.join(directory, ".env.local");
    writeFileSync(targetPath, "AUTHORITY=old\n");
    const planDirectory = path.join(directory, "plan");
    mkdirSync(planDirectory);
    const namesPath = path.join(planDirectory, "names");
    const assignmentsPath = path.join(planDirectory, "assignments");
    writeFileSync(namesPath, "AUTHORITY\n");
    writeFileSync(assignmentsPath, 'OTHER="not-allowlisted"\n');

    expect(() =>
      reconcileForTest({ targetPath, namesPath, assignmentsPath }),
    ).toThrow("SYSTEMD_ENVIRONMENT_PLAN_INVALID");
    expect(readFileSync(targetPath, "utf8")).toBe("AUTHORITY=old\n");
    expect(readdirSync(directory).sort()).toEqual([".env.local", "plan"]);
  });

  test("detects an unlocked concurrent writer and retries without losing its entry", () => {
    const directory = temporaryDirectory();
    const targetPath = path.join(directory, ".env.local");
    writeFileSync(targetPath, "KEEP=initial\nROTATE=old\n");
    const plan = writePlan(directory, ["ROTATE"], { ROTATE: "new" });
    let injected = false;

    reconcileForTest({
      targetPath,
      ...plan,
      beforeRename: (_candidatePath, attempt) => {
        if (attempt === 0 && !injected) {
          injected = true;
          writeFileSync(
            targetPath,
            "KEEP=initial\nCONCURRENT_WRITER=preserved\nROTATE=old\n",
          );
        }
      },
    });

    const contents = readFileSync(targetPath, "utf8");
    expect(injected).toBe(true);
    expect(contents).toContain("CONCURRENT_WRITER=preserved\n");
    expect(lookupSystemdEnvironmentValue(contents, "ROTATE")).toBe("new");
  });

  test("removes legacy assignments with systemd key whitespace", () => {
    const directory = temporaryDirectory();
    const targetPath = path.join(directory, ".env.local");
    writeFileSync(
      targetPath,
      "  AGENT_BACKUP_STEWARD_KMS_TOKEN \t=must-disappear\nKEEP=stable\n",
    );
    const plan = writePlan(directory, ["AGENT_BACKUP_STEWARD_KMS_TOKEN"], {});

    reconcileForTest({ targetPath, ...plan });

    const contents = readFileSync(targetPath, "utf8");
    expect(contents).toBe("KEEP=stable\n");
    expect(contents).not.toContain("must-disappear");
  });

  test("rejects ambiguous multiline syntax without changing the target", () => {
    const directory = temporaryDirectory();
    const targetPath = path.join(directory, ".env.local");
    const oldContents = "KEEP=stable\\\ncontinued-secret\nROTATE=old\n";
    writeFileSync(targetPath, oldContents);
    const plan = writePlan(directory, ["ROTATE"], { ROTATE: "new" });

    expect(() => reconcileForTest({ targetPath, ...plan })).toThrow(
      "SYSTEMD_ENVIRONMENT_VALUE_INVALID",
    );
    expect(readFileSync(targetPath, "utf8")).toBe(oldContents);
  });

  test("rejects invalid UTF-8 without changing the target", () => {
    const directory = temporaryDirectory();
    const targetPath = path.join(directory, ".env.local");
    const oldContents = Buffer.from([0x4b, 0x45, 0x59, 0x3d, 0xff, 0x0a]);
    writeFileSync(targetPath, oldContents);
    const plan = writePlan(directory, ["KEY"], { KEY: "new" });

    expect(() => reconcileForTest({ targetPath, ...plan })).toThrow(
      "SYSTEMD_ENVIRONMENT_FILE_INVALID",
    );
    expect(readFileSync(targetPath)).toEqual(oldContents);
  });

  test("closed root-style checks return only status and never file values", () => {
    const directory = temporaryDirectory();
    const targetPath = path.join(directory, "runtime.env");
    const sentinel = "AKIA_DO_NOT_LEAK_ENVIRONMENT_VALUE";
    writeFileSync(
      targetPath,
      [
        serializeSystemdEnvironmentLine("AUTHORITY", sentinel),
        serializeSystemdEnvironmentLine("EMPTY_VALUE", ""),
      ].join(""),
    );

    const present = runClosedCheck("nonempty", targetPath, ["AUTHORITY"]);
    expect(present.exitCode).toBe(0);
    expect(present.stdout.toString()).toBe("");
    expect(present.stderr.toString()).toBe("");

    const equal = runClosedCheck("equals", targetPath, ["AUTHORITY"], sentinel);
    expect(equal.exitCode).toBe(0);
    expect(equal.stdout.toString()).toBe("");
    expect(equal.stderr.toString()).toBe("");

    const rejected = runClosedCheck("nonempty", targetPath, ["EMPTY_VALUE"]);
    expect(rejected.exitCode).toBe(78);
    expect(rejected.stdout.toString()).toBe("");
    expect(rejected.stderr.toString()).toContain(
      "SYSTEMD_ENVIRONMENT_VALUE_EMPTY",
    );
    expect(rejected.stderr.toString()).not.toContain(sentinel);
  });
});

const systemdAnalyze = Bun.which("systemd-analyze");
const systemdVerificationRequired =
  process.platform === "linux" || process.env.CI === "true";
test("systemd-analyze accepts a unit that consumes the serialized EnvironmentFile", () => {
  if (!systemdAnalyze) {
    if (systemdVerificationRequired) {
      throw new Error("systemd-analyze is required on Linux/CI");
    }
    return;
  }
  const directory = temporaryDirectory();
  const environmentPath = path.join(directory, "runtime.env");
  const unitPath = path.join(directory, "serializer-test.service");
  writeFileSync(
    environmentPath,
    serializeSystemdEnvironmentLine(
      "SERIALIZER_SYSTEMD_VALUE",
      'spaces # semicolon; slash\\ quote"',
    ),
  );
  writeFileSync(
    unitPath,
    [
      "[Unit]",
      "Description=Environment serializer verification",
      "[Service]",
      "Type=oneshot",
      `EnvironmentFile=${environmentPath}`,
      "ExecStart=/usr/bin/env",
      "",
    ].join("\n"),
  );

  const result = Bun.spawnSync([systemdAnalyze, "verify", unitPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});

test("systemd-analyze accepts the shipped DynamicUser hardening directives", () => {
  if (!systemdAnalyze) {
    if (systemdVerificationRequired) {
      throw new Error("systemd-analyze is required on Linux/CI");
    }
    return;
  }
  const directory = temporaryDirectory();
  const environmentPath = path.join(directory, "backup.env");
  const unitPath = path.join(directory, "backup-worker.service");
  writeFileSync(environmentPath, 'AGENT_BACKUP_CATALOG_RUNTIME_ENABLED="0"\n');
  const service = readFileSync(backupService, "utf8");
  expect(service).toContain("DynamicUser=yes");
  expect(service).not.toContain("User=deploy");
  expect(service).not.toContain("Group=deploy");
  writeFileSync(
    unitPath,
    service
      .replace(/^WorkingDirectory=.*$/m, `WorkingDirectory=${directory}`)
      .replace(/^EnvironmentFile=.*$/m, `EnvironmentFile=${environmentPath}`)
      .replace(/^ExecStart=.*$/m, "ExecStart=/usr/bin/true"),
  );

  const result = Bun.spawnSync([systemdAnalyze, "verify", unitPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});

const systemdRun = Bun.which("systemd-run");
const systemdUserManagerAvailable = (() => {
  if (!systemdRun || !Bun.which("env")) return false;
  const result = Bun.spawnSync([
    systemdRun,
    "--user",
    "--wait",
    "--pipe",
    "--quiet",
    "--collect",
    "/usr/bin/true",
  ]);
  return result.exitCode === 0;
})();

test.skipIf(!systemdUserManagerAvailable)(
  "systemd-run consumes the exact serialized value when a user manager is available",
  () => {
    if (!systemdRun) throw new Error("systemd-run disappeared");
    const directory = temporaryDirectory();
    const environmentPath = path.join(directory, "runtime.env");
    const expected = 'spaces # semicolon; slash\\ quote"';
    writeFileSync(
      environmentPath,
      serializeSystemdEnvironmentLine("SERIALIZER_SYSTEMD_VALUE", expected),
    );

    const result = Bun.spawnSync(
      [
        systemdRun,
        "--user",
        "--wait",
        "--pipe",
        "--quiet",
        "--collect",
        `--property=EnvironmentFile=${environmentPath}`,
        "/usr/bin/env",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const assignment = result.stdout
      .toString()
      .split("\n")
      .find((line) => line.startsWith("SERIALIZER_SYSTEMD_VALUE="));
    expect(assignment).toBe(`SERIALIZER_SYSTEMD_VALUE=${expected}`);
  },
);
