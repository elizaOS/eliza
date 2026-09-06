/** Executes the actual remote absence-probe shell with a controlled Docker CLI boundary. */
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteDockerRetainedContainer } from "./docker-retained-stop";

const containerId = "a".repeat(64);
const agentId = "11111111-1111-4111-8111-111111111111";
for (const scenario of ["absent", "other-id", "permission", "timeout"] as const) {
  test(`real shell treats ${scenario} Docker readback with exact absence semantics`, async () => {
    const root = mkdtempSync(join(tmpdir(), "retained-delete-probe-"));
    const docker = join(root, "docker");
    const timeout = join(root, "timeout");
    const message =
      scenario === "permission"
        ? "permission denied connecting to Docker"
        : `Error response from daemon: No such container: ${scenario === "other-id" ? "b".repeat(64) : containerId}`;
    writeFileSync(
      docker,
      `#!/bin/sh\nprintf '\\n%s\\n' '${message}' >&2\nexit ${scenario === "timeout" ? 124 : 1}\n`,
      { mode: 0o700 },
    );
    writeFileSync(timeout, '#!/bin/sh\nshift 3\nexec "$@"\n', { mode: 0o700 });
    let reads = 0;
    const execute = async (command: string) => {
      if (!command.startsWith("sh -lc ")) throw new Error("Unexpected destructive command");
      reads++;
      return execFileSync(
        "sh",
        [
          "-c",
          command
            .replaceAll("timeout -k", `${timeout} -k`)
            .replaceAll("docker container inspect", `${docker} container inspect`),
        ],
        { encoding: "utf8", timeout: 5000 },
      );
    };
    try {
      if (scenario === "absent") await deleteDockerRetainedContainer(execute, containerId, agentId);
      else
        await expect(deleteDockerRetainedContainer(execute, containerId, agentId)).rejects.toThrow(
          "cannot prove exact ownership or absence",
        );
      expect(reads).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
