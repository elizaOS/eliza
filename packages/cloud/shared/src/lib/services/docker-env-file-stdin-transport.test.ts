/**
 * Exercises the generic Docker env-file stdin transport through the exact
 * production builder and a real local `/bin/sh` execution boundary.
 */
import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDockerEnvFileStdinTransport,
  shellQuote,
  validateDockerEnvFileStdinEnvironment,
} from "./docker-sandbox-utils";

interface ShellResult {
  code: number | null;
  output: string;
}

const RUN_REAL_DOCKER = process.env.ELIZA_DOCKER_ENV_STDIN_REAL === "1";
const TEST_PRIVATE_KEY_HEADER = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");

async function runShell(
  command: string,
  input: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ShellResult> {
  return new Promise<ShellResult>((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], { env });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk.toString()));
    child.stderr.on("data", (chunk) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
    child.stdin.end(input);
  });
}

function makeTemporaryDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("generic Docker env-file stdin transport", () => {
  test("keeps arbitrary keys and values out of command argv", () => {
    const environment = Object.fromEntries([
      ["ARGV_SENTINEL_KEY", "argv-sentinel-value with spaces = and 'quotes'"],
      ["DATABASE_URL", "postgresql://user:argv-sentinel-password@example.invalid/app"],
      ["__proto__", "prototype-key-is-data"],
    ]);
    const transport = buildDockerEnvFileStdinTransport(environment, (envFilePath) =>
      ["docker create", `--env-file ${envFilePath}`, "image:latest"].join(" "),
    );

    expect(transport.command).toContain('--env-file "$env_file"');
    expect(transport.command).not.toContain(" -e ");
    for (const [key, value] of Object.entries(environment)) {
      expect(transport.command).not.toContain(key);
      expect(transport.command).not.toContain(value);
      expect(transport.input).toContain(`export ${key}=${shellQuote(value)}`);
    }
    expect(transport.input).not.toContain("ELIZA_VAULT_PASSPHRASE");
  });

  test("round-trips multiline, trailing LF, quotes, Unicode, empty, and 70 KiB values", async () => {
    const temporaryDirectory = makeTemporaryDirectory("eliza-env-roundtrip-");
    try {
      const environment = {
        PEM: `${TEST_PRIVATE_KEY_HEADER}\nline with ' quote\tand tab\n-----END-----\n`,
        QUOTED: " leading = 'quotes' \\slashes\\ and trailing ",
        UNICODE: "clé-🧪-東京",
        EMPTY: "",
        LARGE: "x".repeat(70 * 1024),
      };
      const outputPaths = Object.fromEntries(
        Object.keys(environment).map((key) => [key, join(temporaryDirectory, `${key}.out`)]),
      );
      const capturedEnvPath = join(temporaryDirectory, "captured.env");
      const transport = buildDockerEnvFileStdinTransport(
        environment,
        (envFilePath) =>
          [
            `test "$(find ${envFilePath} -prune -perm 0600 -print)" = ${envFilePath}`,
            ...Object.entries(outputPaths).map(
              ([key, outputPath]) => `printf '%s' "$${key}" > ${shellQuote(outputPath)}`,
            ),
            `cp ${envFilePath} ${shellQuote(capturedEnvPath)}`,
          ].join("; "),
        { temporaryDirectory },
      );

      expect(transport.command).not.toContain(environment.PEM);
      expect(transport.command).not.toContain(environment.LARGE);
      const result = await runShell(transport.command, transport.input);

      expect(result).toEqual({ code: 0, output: "" });
      for (const [key, value] of Object.entries(environment)) {
        expect(readFileSync(outputPaths[key]!, "utf8")).toBe(value);
      }
      expect(readFileSync(capturedEnvPath, "utf8")).toBe(
        `${Object.keys(environment).join("\n")}\n`,
      );
      expect(readdirSync(temporaryDirectory).sort()).toEqual(
        [...Object.keys(environment).map((key) => `${key}.out`), "captured.env"].sort(),
      );
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test("keeps Docker and shell control variables out of the wrapper process environment", async () => {
    const temporaryDirectory = makeTemporaryDirectory("eliza-control-env-");
    try {
      const dockerHost = "tcp://caller-must-not-steer-docker.invalid:2375";
      const httpProxy = "http://container-only-proxy.invalid:3128";
      const capturedEnvPath = join(temporaryDirectory, "captured.env");
      const capturedProcessPath = join(temporaryDirectory, "captured.process");
      const transport = buildDockerEnvFileStdinTransport(
        { DOCKER_HOST: dockerHost, HTTP_PROXY: httpProxy },
        (envFilePath) =>
          [
            `cp ${envFilePath} ${shellQuote(capturedEnvPath)}`,
            `printf '%s\n%s' "\${DOCKER_HOST-unset}" "\${HTTP_PROXY-unset}" > ${shellQuote(capturedProcessPath)}`,
          ].join("; "),
        { temporaryDirectory },
      );
      const cleanEnvironment = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => key !== "DOCKER_HOST" && key !== "HTTP_PROXY",
        ),
      );

      expect(transport.input).not.toContain("export DOCKER_HOST=");
      expect(transport.input).not.toContain("export HTTP_PROXY=");
      const result = await runShell(transport.command, transport.input, cleanEnvironment);

      expect(result).toEqual({ code: 0, output: "" });
      expect(readFileSync(capturedEnvPath, "utf8")).toBe(
        `DOCKER_HOST=${dockerHost}\nHTTP_PROXY=${httpProxy}\n`,
      );
      expect(readFileSync(capturedProcessPath, "utf8")).toBe("unset\nunset");
      expect(readdirSync(temporaryDirectory).sort()).toEqual(["captured.env", "captured.process"]);
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test("uses mode 0600 and cleans temporary files after success and failure", async () => {
    for (const dockerResult of ["true", "false"]) {
      const temporaryDirectory = makeTemporaryDirectory("eliza-env-cleanup-");
      try {
        const capturedEnvPath = join(temporaryDirectory, "captured.env");
        const transport = buildDockerEnvFileStdinTransport(
          { API_TOKEN: "stdin-only-sentinel" },
          (envFilePath) =>
            [
              `test "$(find ${envFilePath} -prune -perm 0600 -print)" = ${envFilePath}`,
              `cp ${envFilePath} ${shellQuote(capturedEnvPath)}`,
              dockerResult,
            ].join("; "),
          { temporaryDirectory },
        );

        const result = await runShell(transport.command, transport.input);

        expect(result.code === 0).toBe(dockerResult === "true");
        expect(result.output).toBe("");
        expect(readFileSync(capturedEnvPath, "utf8")).toBe("API_TOKEN\n");
        expect(readdirSync(temporaryDirectory)).toEqual(["captured.env"]);
      } finally {
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    }
  });

  test("rejects impossible environments before building a remote command", () => {
    expect(() => validateDockerEnvFileStdinEnvironment({ PRIVATE_KEY: "nul\0value" })).toThrow(
      /contains NUL/,
    );
    expect(() =>
      buildDockerEnvFileStdinTransport({ PRIVATE_KEY: "x".repeat(121 * 1024) }, () => "true"),
    ).toThrow(/process entry limit/);
    expect(() =>
      buildDockerEnvFileStdinTransport(
        {
          A: "a".repeat(90 * 1024),
          B: "b".repeat(90 * 1024),
          C: "c".repeat(90 * 1024),
        },
        () => "true",
      ),
    ).toThrow(/transport limit/);
    expect(() =>
      buildDockerEnvFileStdinTransport({ DOCKER_HOST: "line1\nline2" }, () => "true"),
    ).toThrow(/must be single-line/);
    expect(() =>
      buildDockerEnvFileStdinTransport({ QUOTE_HEAVY: "'".repeat(60 * 1024) }, () => "true"),
    ).toThrow(/environment frame exceeds/);
    for (const key of ["env_file", "env_frame_file", "env_end_file"]) {
      expect(() => buildDockerEnvFileStdinTransport({ [key]: "collision" }, () => "true")).toThrow(
        /reserved by the Docker stdin transport/,
      );
    }
    expect(() => buildDockerEnvFileStdinTransport({}, () => "")).toThrow(/non-empty command/);
  });

  test("fails closed and cleans up truncated, corrupt, oversized, or overlong frames", async () => {
    const temporaryDirectory = makeTemporaryDirectory("eliza-invalid-frame-");
    try {
      const shouldNotRun = join(temporaryDirectory, "should-not-run");
      const transport = buildDockerEnvFileStdinTransport(
        { API_TOKEN: "must-not-echo" },
        () => `touch ${shellQuote(shouldNotRun)}`,
        { temporaryDirectory },
      );
      const invalidInputs = [
        transport.input.slice(0, -10),
        transport.input.replace(
          "ELIZA_DOCKER_ENV_FILE_STDIN_V1_END",
          "ELIZA_DOCKER_ENV_FILE_STDIN_V1_BAD",
        ),
        `${transport.input}x`,
        "ELIZA_DOCKER_ENV_FILE_STDIN_V1 262145\n",
      ];

      for (const input of invalidInputs) {
        const result = await runShell(transport.command, input);
        expect(result.code).not.toBe(0);
        expect(result.output).toBe("");
        expect(result.output).not.toContain("must-not-echo");
        expect(existsSync(shouldNotRun)).toBe(false);
        expect(readdirSync(temporaryDirectory)).toEqual([]);
      }
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test("cleans temporary files when the remote command is interrupted", async () => {
    const temporaryDirectory = makeTemporaryDirectory("eliza-signal-env-");
    const readyPath = join(temporaryDirectory, "ready");
    const transport = buildDockerEnvFileStdinTransport(
      { API_TOKEN: "stdin-only-sentinel" },
      () => `touch ${shellQuote(readyPath)}; sleep 30`,
      { temporaryDirectory },
    );
    const child = spawn("/bin/sh", ["-c", transport.command], { detached: true });
    child.stdin.end(transport.input);

    try {
      for (let attempt = 0; attempt < 200 && !existsSync(readyPath); attempt++) {
        await Bun.sleep(10);
      }
      expect(existsSync(readyPath)).toBe(true);
      expect(readdirSync(temporaryDirectory).length).toBeGreaterThan(1);

      const closePromise = new Promise<void>((resolve) => child.on("close", () => resolve()));
      process.kill(-child.pid!, "SIGTERM");
      await closePromise;

      expect(readdirSync(temporaryDirectory)).toEqual(["ready"]);
    } finally {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // The process group already exited after the handled signal.
      }
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }, 10_000);
});

describe.skipIf(!RUN_REAL_DOCKER)(
  "generic Docker env-file stdin transport — real Docker opt-in (#23804)",
  () => {
    test("round-trips the exact production plan through a disposable container", () => {
      const temporaryDirectory = makeTemporaryDirectory("eliza-real-docker-env-");
      const containerName = `eliza-env-proof-23804-${process.pid}`;
      const environment = {
        EMPTY: "",
        QUOTED: " leading = 'quotes' \\slashes\\ and trailing ",
        UNICODE: "clé-🧪-東京",
        PEM: `${TEST_PRIVATE_KEY_HEADER}\nline with ' quote\tand tab\n-----END PRIVATE KEY-----\n`,
        LARGE: "x".repeat(70 * 1024),
        DOCKER_HOST: "tcp://container-only.invalid:2375",
        HTTP_PROXY: " http://container-only.invalid:3128 ",
      };
      const docker = (...args: string[]) =>
        spawnSync("docker", args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });

      try {
        docker("rm", "-f", containerName);
        const transport = buildDockerEnvFileStdinTransport(
          environment,
          (envFilePath) =>
            [
              `test "$(find ${envFilePath} -prune -perm 0600 -print)" = ${envFilePath} &&`,
              "docker create",
              `--name ${shellQuote(containerName)}`,
              `--env-file ${envFilePath}`,
              shellQuote("alpine:3.23"),
              "env",
            ].join(" "),
          { temporaryDirectory },
        );

        expect(transport.command).not.toContain(" -e ");
        for (const [key, value] of Object.entries(environment)) {
          expect(transport.command).not.toContain(key);
          if (value.length > 0) expect(transport.command).not.toContain(value);
        }

        const created = spawnSync("/bin/sh", ["-c", transport.command], {
          input: transport.input,
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
        });
        expect(created.status, `${created.stderr}${created.stdout}`).toBe(0);
        expect(readdirSync(temporaryDirectory)).toEqual([]);

        const inspected = docker("inspect", "--format", "{{json .Config.Env}}", containerName);
        expect(inspected.status, inspected.stderr).toBe(0);
        const entries = JSON.parse(inspected.stdout.trim()) as string[];
        const actual = new Map(
          entries.map((entry) => {
            const separator = entry.indexOf("=");
            return [entry.slice(0, separator), entry.slice(separator + 1)];
          }),
        );
        for (const [key, expected] of Object.entries(environment)) {
          expect(actual.get(key)).toBe(expected);
        }
      } finally {
        docker("rm", "-f", containerName);
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    }, 30_000);
  },
);
