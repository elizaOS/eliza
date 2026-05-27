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
    expect(cmd).toBe(
      "docker network inspect 'containers-isolated' >/dev/null 2>&1 || " +
        "docker network create --driver bridge 'containers-isolated' >/dev/null 2>&1 || " +
        "docker network inspect 'containers-isolated' >/dev/null 2>&1",
    );
  });

  test("re-inspects after create to survive a concurrent create race", () => {
    const cmd = buildEnsureNetworkCmd("net");
    // inspect ... || create ... || inspect ...  → three clauses
    expect(cmd.split("||").length).toBe(3);
    expect(cmd.startsWith("docker network inspect")).toBe(true);
    expect(cmd.trim().endsWith("docker network inspect 'net' >/dev/null 2>&1")).toBe(true);
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
});
