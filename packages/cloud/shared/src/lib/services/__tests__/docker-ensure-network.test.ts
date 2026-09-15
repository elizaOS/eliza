/**
 * Covers buildEnsureNetworkCmd — the idempotent, race-safe command the
 * provisioner runs before `docker create --network` so a node missing the
 * shared bridge network (Robot cores, pruned networks) self-heals instead of
 * failing every provision with "network not found".
 */
import { describe, expect, test } from "bun:test";
import { buildEnsureNetworkCmd } from "../docker-sandbox-utils";

describe("buildEnsureNetworkCmd", () => {
  test("inspects first, creates only if missing", () => {
    const cmd = buildEnsureNetworkCmd("containers-isolated");
    const firstInspect = cmd.indexOf("docker network inspect 'containers-isolated'");
    const create = cmd.indexOf("docker network create --driver bridge 'containers-isolated'");
    expect(firstInspect).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(firstInspect);
  });

  test("re-inspects after create to survive a concurrent create race", () => {
    const cmd = buildEnsureNetworkCmd("net");
    expect(cmd.match(/docker network inspect 'net'/g)).toHaveLength(2);
    expect(
      cmd.indexOf("docker network inspect 'net'", cmd.indexOf("docker network create")),
    ).toBeGreaterThan(cmd.indexOf("docker network create"));
  });

  test("only ever creates a plain bridge network (no implicit subnet)", () => {
    const cmd = buildEnsureNetworkCmd("net");
    expect(cmd).toContain("docker network create --driver bridge 'net'");
    expect(cmd).not.toContain("--subnet");
  });

  test("shell-escapes the network name", () => {
    const cmd = buildEnsureNetworkCmd("a'b");
    // single quote is closed/escaped/reopened, never left bare
    expect(cmd).toContain(`'a'"'"'b'`);
    expect(cmd).not.toContain(" a'b ");
  });

  test("emits only fixed diagnostics after the race-safe retry fails", () => {
    const cmd = buildEnsureNetworkCmd("net");
    expect(cmd).toContain("docker info >/dev/null 2>&1");
    expect(cmd).toContain("[docker-network] daemon-unavailable");
    expect(cmd).toContain("[docker-network] ensure-failed");
  });
});
