import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

// These tests spawn the docker entrypoint shell scripts through `/bin/sh`,
// which only exists on POSIX. The Docker images these entrypoints belong
// to are Linux-only (alpine/debian), so on Windows we skip the whole
// suite rather than fail. Run on Linux/macOS (or inside WSL) to exercise.
const describeIfPosix =
  process.platform === "win32" ? describe.skip : describe;

const cloudAgentEntrypoint = path.resolve(
  import.meta.dirname,
  "../deploy/cloud-agent-docker-entrypoint.sh",
);
const dockerEntrypoint = path.resolve(
  import.meta.dirname,
  "docker-entrypoint.sh",
);

function runEntrypoint(
  env: NodeJS.ProcessEnv,
  command: string[] = ["/bin/sh", "-c", "printf app-started"],
): { code: number | null; stdout: string; stderr: string } {
  const child = spawnSync("/bin/sh", [cloudAgentEntrypoint, ...command], {
    env,
    encoding: "utf8",
  });
  return {
    code: child.status,
    stdout: child.stdout,
    stderr: child.stderr,
  };
}

function runDockerEntrypoint(
  env: NodeJS.ProcessEnv,
  command: string[] = ["/bin/sh", "-c", "printf app-started"],
): { code: number | null; stdout: string; stderr: string } {
  const child = spawnSync("/bin/sh", [dockerEntrypoint, ...command], {
    env,
    encoding: "utf8",
  });
  return {
    code: child.status,
    stdout: child.stdout,
    stderr: child.stderr,
  };
}

async function writeExecutable(filePath: string, body: string) {
  await writeFile(filePath, body, { mode: 0o755 });
}

describeIfPosix("docker entrypoint", () => {
  test("preserves port normalization and starts without tailscale when no auth key is configured", () => {
    const result = runDockerEntrypoint(
      {
        ...process.env,
        PORT: "9999",
        ELIZA_PORT: "8888",
        TS_AUTHKEY: "",
      },
      [
        "/bin/sh",
        "-c",
        'printf "ELIZA_PORT=%s ELIZA_API_PORT=%s" "$ELIZA_PORT" "$ELIZA_API_PORT"',
      ],
    );

    expect(result).toMatchObject({
      code: 0,
      stdout: "ELIZA_PORT=9999 ELIZA_API_PORT=9999",
    });
  });

  test("starts tailscaled and joins headscale before agent startup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "docker-entrypoint-"));
    const binDir = path.join(root, "bin");
    const stateDir = path.join(root, "state");
    const socketPath = path.join(root, "tailscaled.sock");
    const argsLog = path.join(root, "tailscale-args.log");
    await mkdir(binDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    await writeExecutable(
      path.join(binDir, "id"),
      `#!/bin/sh
if [ "$1" = "-u" ]; then
  printf 0
  exit 0
fi
exec /usr/bin/id "$@"
`,
    );

    await writeExecutable(
      path.join(binDir, "tailscaled"),
      `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    --socket=*) socket="\${arg#--socket=}" ;;
  esac
done
: "\${socket:=${socketPath}}"
mkdir -p "$(dirname "$socket")"
: > "$socket"
sleep 5
`,
    );

    await writeExecutable(
      path.join(binDir, "tailscale"),
      `#!/bin/sh
printf '%s\\n' "$@" > "$TAILSCALE_ARGS_LOG"
`,
    );

    const result = runDockerEntrypoint(
      {
        PATH: `${binDir}:/usr/bin:/bin`,
        PORT: "9999",
        ELIZA_PORT: "8888",
        TS_AUTHKEY: "tskey-ci-test",
        SANDBOX_AGENT_ID: "agent-ci-test",
        TS_STATE_DIR: stateDir,
        TS_SOCKET: socketPath,
        HEADSCALE_URL: "https://headscale.example.test",
        TS_EXTRA_ARGS: "--accept-routes",
        TAILSCALE_ARGS_LOG: argsLog,
      },
      [
        "/bin/sh",
        "-c",
        'printf "ELIZA_PORT=%s TS_SOCKET=%s" "$ELIZA_PORT" "$TS_SOCKET"',
      ],
    );

    expect(result).toMatchObject({
      code: 0,
      stdout: `ELIZA_PORT=9999 TS_SOCKET=${socketPath}`,
    });

    const args = await readFile(argsLog, "utf8");
    expect(args).toContain(`--socket=${socketPath}`);
    expect(args).toContain("up");
    expect(args).toContain("--auth-key=tskey-ci-test");
    expect(args).toContain("--hostname=agent-ci-test");
    expect(args).toContain("--login-server=https://headscale.example.test");
    expect(args).toContain("--accept-routes");
  });

  test("fails clearly when tailscale is requested but unavailable", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "docker-entrypoint-missing-tailscale-"),
    );
    const binDir = path.join(root, "bin");
    await mkdir(binDir, { recursive: true });

    await writeExecutable(
      path.join(binDir, "id"),
      `#!/bin/sh
if [ "$1" = "-u" ]; then
  printf 0
  exit 0
fi
exec /usr/bin/id "$@"
`,
    );

    const result = runDockerEntrypoint(
      {
        PATH: `${binDir}:/usr/bin:/bin`,
        TS_AUTHKEY: "tskey-ci-test",
      },
      ["/bin/sh", "-c", "printf should-not-start"],
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "[docker-entrypoint] TS_AUTHKEY is set but tailscale/tailscaled is not installed",
    );
    expect(result.stdout).toBe("");
  });
});

describeIfPosix("cloud-agent docker entrypoint", () => {
  test("starts the cloud-agent command without tailscale when no auth key is configured", () => {
    const result = runEntrypoint(
      {
        ...process.env,
        TS_AUTHKEY: "",
      },
      ["/bin/sh", "-c", "printf cloud-started"],
    );

    expect(result).toMatchObject({
      code: 0,
      stdout: "cloud-started",
    });
  });

  test("starts tailscaled, joins headscale, and drops privileges before cloud-agent startup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cloud-agent-entrypoint-"));
    const binDir = path.join(root, "bin");
    const stateDir = path.join(root, "state");
    const socketPath = path.join(root, "tailscaled.sock");
    const argsLog = path.join(root, "tailscale-args.log");
    const gosuUserLog = path.join(root, "gosu-user.log");
    await mkdir(binDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    await writeExecutable(
      path.join(binDir, "id"),
      `#!/bin/sh
if [ "$1" = "-u" ]; then
  printf 0
  exit 0
fi
exec /usr/bin/id "$@"
`,
    );

    await writeExecutable(
      path.join(binDir, "tailscaled"),
      `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    --socket=*) socket="\${arg#--socket=}" ;;
  esac
done
: "\${socket:=${socketPath}}"
mkdir -p "$(dirname "$socket")"
: > "$socket"
sleep 5
`,
    );

    await writeExecutable(
      path.join(binDir, "tailscale"),
      `#!/bin/sh
printf '%s\\n' "$@" > "$TAILSCALE_ARGS_LOG"
`,
    );

    await writeExecutable(
      path.join(binDir, "gosu"),
      `#!/bin/sh
printf '%s\\n' "$1" > "$GOSU_USER_LOG"
shift
exec "$@"
`,
    );

    const result = runEntrypoint(
      {
        PATH: `${binDir}:/usr/bin:/bin`,
        TS_AUTHKEY: "tskey-cloud-test",
        SANDBOX_AGENT_ID: "agent-cloud-test",
        TS_STATE_DIR: stateDir,
        TS_SOCKET: socketPath,
        HEADSCALE_URL: "https://headscale.example.test",
        TS_EXTRA_ARGS: "--accept-routes",
        TAILSCALE_ARGS_LOG: argsLog,
        GOSU_USER_LOG: gosuUserLog,
      },
      ["/bin/sh", "-c", "printf cloud-started"],
    );

    expect(result).toMatchObject({ code: 0, stdout: "cloud-started" });

    const args = await readFile(argsLog, "utf8");
    expect(args).toContain(`--socket=${socketPath}`);
    expect(args).toContain("up");
    expect(args).toContain("--auth-key=tskey-cloud-test");
    expect(args).toContain("--hostname=agent-cloud-test");
    expect(args).toContain("--login-server=https://headscale.example.test");
    expect(args).toContain("--accept-routes");
    await expect(readFile(gosuUserLog, "utf8")).resolves.toBe("agent\n");
  });
});
