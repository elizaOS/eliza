/**
 * Runs public retained-provider operations through a real shell and a scripted
 * Docker boundary. Proves SSH-host daemon selection, not real Docker state.
 */
import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerSandboxProvider } from "./docker-sandbox-provider";
import { DockerSSHClient } from "./docker-ssh";

const ID = "a".repeat(64);
const AGENT = "11111111-1111-4111-8111-111111111111";

afterEach(() => mock.restore());

test.each(["capture", "delete"] as const)(
  "retained %s uses the captured SSH host despite ambient Docker redirection",
  async (operation) => {
    const root = mkdtempSync(join(tmpdir(), "eliza-retained-daemon-"));
    const bin = join(root, "bin");
    const observed = join(root, "observed");
    const removed = join(root, "removed");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/sh
printf '%s|%s|%s\\n' "$DOCKER_HOST" "\${DOCKER_CONTEXT-unset}" "$DOCKER_CONFIG" >> "$FIXTURE_OBSERVED"
while test "$1" = --host || test "$1" = --config; do shift 2; done
if test "$DOCKER_HOST" != unix:///var/run/docker.sock || test -f "$FIXTURE_REMOVED"; then
  printf 'Error: No such container: ${ID}\\n' >&2
  exit 1
fi
case "$*" in
  *inspect*'.State.Status'*) printf '${ID}|${AGENT}|exited|false|false|false|false|no\\n' ;;
  *inspect*'.Name'*) printf '${ID}|${AGENT}|/agent-${AGENT}\\n' ;;
  *inspect*) printf '${ID}|${AGENT}\\n' ;;
  rm*) touch "$FIXTURE_REMOVED" ;;
  update*|stop*) printf '${ID}\\n' ;;
  *) exit 64 ;;
esac
`,
      { mode: 0o700 },
    );
    writeFileSync(join(bin, "timeout"), '#!/bin/sh\nshift 3\nexec "$@"\n', { mode: 0o700 });
    spyOn(DockerSSHClient.prototype, "exec").mockImplementation(
      async (command) =>
        new Promise<string>((resolve, reject) => {
          const child = spawn(
            "/bin/sh",
            [
              "-c",
              command
                .replaceAll("chmod 700 --", "chmod 700")
                .replaceAll("chmod 600 --", "chmod 600"),
            ],
            {
              env: {
                ...process.env,
                PATH: `${bin}:${process.env.PATH}`,
                DOCKER_HOST: "tcp://other-host.invalid:2376",
                DOCKER_CONTEXT: "other-host",
                DOCKER_CONFIG: join(root, "ambient-config"),
                DOCKER_TLS_VERIFY: "1",
                FIXTURE_OBSERVED: observed,
                FIXTURE_REMOVED: removed,
              },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
          });
          child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
          });
          child.on("error", reject);
          child.on("close", (code) =>
            code === 0 ? resolve(stdout) : reject(new Error(`Shell exited ${code}: ${stderr}`)),
          );
        }),
    );
    const sshBoundary = Object.create(DockerSSHClient.prototype) as DockerSSHClient;
    spyOn(DockerSSHClient, "createDedicated").mockReturnValue(sshBoundary);
    spyOn(sshBoundary, "disconnect").mockResolvedValue(undefined);
    const provider = new DockerSandboxProvider();
    const locator = {
      agentId: AGENT,
      containerName: `agent-${AGENT}`,
      sandboxId: `agent-${AGENT}`,
      containerId: ID,
      nodeId: "fixture-host",
      hostname: "192.0.2.42",
      sshPort: 22,
      sshUser: "root",
      hostKeyFingerprint: "SHA256:fixture-host",
    };
    try {
      if (operation === "capture") {
        expect(await provider.captureRetainedContainer(locator)).toBe(ID);
      } else {
        expect(await provider.stopForDeletion(locator.sandboxId, locator)).toEqual({
          kind: "not-running-proven",
        });
        expect(existsSync(removed)).toBe(true);
      }
      const observations = readFileSync(observed, "utf8").trim().split("\n");
      expect(observations.length).toBeGreaterThan(0);
      for (const line of observations) {
        const [host, context, config] = line.split("|");
        expect(host).toBe("unix:///var/run/docker.sock");
        expect(context).toBe("unset");
        expect(config).not.toBe(join(root, "ambient-config"));
        expect(existsSync(config!)).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
