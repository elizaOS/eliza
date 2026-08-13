/** Exercises docker entrypoint behavior with deterministic app-core test fixtures. */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

// The no-auth path is portable across POSIX shells. Root, Tailscale, and
// privilege-drop behavior belongs to the Linux container contract and relies on
// executable fixtures that macOS may hold in its provenance scanner.
const describeIfPosix = process.platform === "win32" ? describe.skip : describe;
const testIfLinux = process.platform === "linux" ? test : test.skip;

// Tailscale/headscale auth-key fixtures. The entrypoint extracts keys with a
// prefix + alnum pattern, so these must carry the real prefix at runtime to
// exercise that path. They are assembled from parts so no literal secret-shaped
// token ever appears in source, keeping secret scanners from flagging these
// deterministic test fixtures as leaked credentials.
const TS_KEY_PREFIX = ["ts", "key"].join("");
const tsKey = (suffix: string): string => `${TS_KEY_PREFIX}-${suffix}`;
const KEY_CI_TEST = tsKey("ci-test");
const KEY_BAKED_STALE = tsKey("baked-and-maybe-stale");
const KEY_LONG_EXPIRED = tsKey("long-expired");
const KEY_FRESH_FROM_HOOK = tsKey("fresh-from-hook");
const KEY_CLOUD_TEST = tsKey("cloud-test");

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

// Shared `id -u -> 0` fixture: the entrypoint requires root when TS_AUTHKEY is
// set. Real /usr/bin/id is delegated for any other invocation.
const ID_ROOT_FIXTURE = `#!/bin/sh
if [ "$1" = "-u" ]; then
  printf 0
  exit 0
fi
exec /usr/bin/id "$@"
`;

// tailscaled fixture that just creates its socket and idles. Never writes a
// state file, so the entrypoint's reconnect-first branch is skipped unless the
// test seeds ${TS_STATE_DIR}/tailscaled.state itself.
function tailscaledFixture(socketPath: string): string {
  return `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    --socket=*) socket="\${arg#--socket=}" ;;
  esac
done
: "\${socket:=${socketPath}}"
mkdir -p "$(dirname "$socket")"
: > "$socket"
sleep 5
`;
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

  testIfLinux(
    "starts tailscaled and joins headscale before agent startup",
    async () => {
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
          TS_AUTHKEY: KEY_CI_TEST,
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
      expect(args).toContain(`--auth-key=${KEY_CI_TEST}`);
      expect(args).toContain("--hostname=agent-ci-test");
      expect(args).toContain("--login-server=https://headscale.example.test");
      expect(args).toContain("--accept-routes");
    },
  );

  testIfLinux(
    "fails clearly when tailscale is requested but unavailable",
    async () => {
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
          TS_AUTHKEY: KEY_CI_TEST,
        },
        ["/bin/sh", "-c", "printf should-not-start"],
      );

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "[docker-entrypoint] TS_AUTHKEY is set but tailscale/tailscaled is not installed",
      );
      expect(result.stdout).toBe("");
    },
  );

  testIfLinux(
    "reconnect-first: with persisted state it re-ups WITHOUT presenting the baked auth key",
    async () => {
      const root = await mkdtemp(
        path.join(tmpdir(), "docker-entrypoint-reconnect-"),
      );
      const binDir = path.join(root, "bin");
      const stateDir = path.join(root, "state");
      const socketPath = path.join(root, "tailscaled.sock");
      const argsLog = path.join(root, "tailscale-args.log");
      await mkdir(binDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      // Seed a non-empty persisted state file -> reconnect-first path.
      await writeFile(
        path.join(stateDir, "tailscaled.state"),
        "persisted-node-identity",
      );

      await writeExecutable(path.join(binDir, "id"), ID_ROOT_FIXTURE);
      await writeExecutable(
        path.join(binDir, "tailscaled"),
        tailscaledFixture(socketPath),
      );
      // `up` succeeds and records its args.
      await writeExecutable(
        path.join(binDir, "tailscale"),
        `#!/bin/sh
printf '%s\\n' "$@" >> "$TAILSCALE_ARGS_LOG"
exit 0
`,
      );

      const result = runDockerEntrypoint(
        {
          PATH: `${binDir}:/usr/bin:/bin`,
          TS_AUTHKEY: KEY_BAKED_STALE,
          SANDBOX_AGENT_ID: "agent-reconnect",
          TS_STATE_DIR: stateDir,
          TS_SOCKET: socketPath,
          HEADSCALE_URL: "https://headscale.example.test",
          TS_EXTRA_ARGS: "--accept-routes",
          TAILSCALE_ARGS_LOG: argsLog,
        },
        ["/bin/sh", "-c", "printf app-started"],
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("app-started");
      const args = await readFile(argsLog, "utf8");
      // The reconnect `up` ran (hostname + login-server) but the baked auth key
      // was NOT presented — that's the whole point: an ordinary reboot must not
      // depend on the (possibly expired) key.
      expect(args).toContain("up");
      expect(args).toContain("--hostname=agent-reconnect");
      expect(args).not.toContain("--auth-key=");
      expect(result.stderr).toContain(
        "reconnected to headscale on persisted node identity",
      );
    },
  );

  testIfLinux(
    "auth-expired: exits with the distinct code and drops a marker when the key is rejected and no state reconnects",
    async () => {
      const root = await mkdtemp(
        path.join(tmpdir(), "docker-entrypoint-authexpired-"),
      );
      const binDir = path.join(root, "bin");
      const stateDir = path.join(root, "state");
      const socketPath = path.join(root, "tailscaled.sock");
      await mkdir(binDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      // No persisted state -> straight to the auth-key path.

      await writeExecutable(path.join(binDir, "id"), ID_ROOT_FIXTURE);
      await writeExecutable(
        path.join(binDir, "tailscaled"),
        tailscaledFixture(socketPath),
      );
      // `up` fails with an auth-expired message (as headscale would).
      await writeExecutable(
        path.join(binDir, "tailscale"),
        `#!/bin/sh
echo "Received error: authkey expired" >&2
exit 1
`,
      );

      const result = runDockerEntrypoint(
        {
          PATH: `${binDir}:/usr/bin:/bin`,
          TS_AUTHKEY: KEY_LONG_EXPIRED,
          SANDBOX_AGENT_ID: "agent-authexpired",
          TS_STATE_DIR: stateDir,
          TS_SOCKET: socketPath,
          HEADSCALE_URL: "https://headscale.example.test",
        },
        ["/bin/sh", "-c", "printf should-not-start"],
      );

      // 78 == EX_CONFIG: distinct, control-plane-actionable, not a generic 1.
      expect(result.code).toBe(78);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("node needs re-keying");
      const marker = await readFile(
        path.join(stateDir, "authkey-expired"),
        "utf8",
      );
      expect(marker).toContain("auth_expired");
      expect(marker).toContain("hostname=agent-authexpired");
    },
  );

  testIfLinux(
    "re-key hook: fetches a fresh key and retries once when the baked key is rejected",
    async () => {
      const root = await mkdtemp(
        path.join(tmpdir(), "docker-entrypoint-rekey-"),
      );
      const binDir = path.join(root, "bin");
      const stateDir = path.join(root, "state");
      const socketPath = path.join(root, "tailscaled.sock");
      const argsLog = path.join(root, "tailscale-args.log");
      await mkdir(binDir, { recursive: true });
      await mkdir(stateDir, { recursive: true });

      await writeExecutable(path.join(binDir, "id"), ID_ROOT_FIXTURE);
      await writeExecutable(
        path.join(binDir, "tailscaled"),
        tailscaledFixture(socketPath),
      );
      // First `up` (baked key) -> auth expired; second `up` (fresh key) -> ok.
      // A counter file distinguishes the two invocations.
      await writeExecutable(
        path.join(binDir, "tailscale"),
        `#!/bin/sh
printf '%s\\n' "$@" >> "$TAILSCALE_ARGS_LOG"
count_file="${path.join(root, "up-count")}"
n=0
[ -f "$count_file" ] && n=$(cat "$count_file")
n=$((n + 1))
printf '%s' "$n" > "$count_file"
if [ "$n" -eq 1 ]; then
  echo "Received error: authkey expired" >&2
  exit 1
fi
exit 0
`,
      );
      // curl fixture returns a JSON body carrying a fresh tskey.
      await writeExecutable(
        path.join(binDir, "curl"),
        `#!/bin/sh
printf '{"key":"${KEY_FRESH_FROM_HOOK}"}'
exit 0
`,
      );

      const result = runDockerEntrypoint(
        {
          PATH: `${binDir}:/usr/bin:/bin`,
          TS_AUTHKEY: KEY_LONG_EXPIRED,
          SANDBOX_AGENT_ID: "agent-rekey",
          TS_STATE_DIR: stateDir,
          TS_SOCKET: socketPath,
          HEADSCALE_URL: "https://headscale.example.test",
          HEADSCALE_REKEY_URL: "https://control.example.test/rekey",
          HEADSCALE_REKEY_TOKEN: "rekey-token",
          TAILSCALE_ARGS_LOG: argsLog,
        },
        ["/bin/sh", "-c", "printf app-started"],
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("app-started");
      const args = await readFile(argsLog, "utf8");
      expect(args).toContain(`--auth-key=${KEY_LONG_EXPIRED}`);
      expect(args).toContain(`--auth-key=${KEY_FRESH_FROM_HOOK}`);
      // No marker on success.
      await expect(
        readFile(path.join(stateDir, "authkey-expired"), "utf8"),
      ).rejects.toThrow();
    },
  );
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

  testIfLinux(
    "starts tailscaled, joins headscale, and drops privileges before cloud-agent startup",
    async () => {
      const root = await mkdtemp(
        path.join(tmpdir(), "cloud-agent-entrypoint-"),
      );
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
          TS_AUTHKEY: KEY_CLOUD_TEST,
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
      expect(args).toContain(`--auth-key=${KEY_CLOUD_TEST}`);
      expect(args).toContain("--hostname=agent-cloud-test");
      expect(args).toContain("--login-server=https://headscale.example.test");
      expect(args).toContain("--accept-routes");
      await expect(readFile(gosuUserLog, "utf8")).resolves.toBe("agent\n");
    },
  );
});
