/** Tests the privacy-safe classifiers used by the live Dedicated mesh diagnostic. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyContainerLogs,
  classifyRuntimeProcessState,
  classifyTailscaleStatus,
  withObservationQuery,
} from "./managed-dedicated-mesh-state-diagnostic";

describe("managed Dedicated mesh-state diagnostic", () => {
  test("retains only closed Tailscale status facts", () => {
    expect(
      classifyTailscaleStatus(
        JSON.stringify({
          BackendState: "NeedsLogin",
          AuthURL: "https://login.tailscale.com/private",
          Self: { MachineAuthorized: false, TailscaleIPs: ["100.64.0.9"] },
        }),
      ),
    ).toEqual({
      query: "success",
      backendState: "NeedsLogin",
      machineAuthorized: false,
      authUrlPresent: true,
    });
  });

  test("fails closed for malformed or unknown status", () => {
    expect(classifyTailscaleStatus("not-json")).toEqual({
      query: "error",
      backendState: null,
      machineAuthorized: null,
      authUrlPresent: false,
    });
    expect(
      classifyTailscaleStatus('{"BackendState":"FuturePrivateState"}'),
    ).toEqual({
      query: "success",
      backendState: null,
      machineAuthorized: null,
      authUrlPresent: false,
    });
  });

  test("maps raw container logs to booleans without returning their text", () => {
    expect(
      classifyContainerLogs(
        "tailscale up failed: auth key expired\nhttps://login.tailscale.com/a/private-token",
      ),
    ).toEqual({
      authKeyRejected: true,
      interactiveAuthRequired: true,
      tailscaleUpFailed: true,
      agentStarted: false,
    });
  });

  test("retains only closed container startup process facts", () => {
    expect(
      classifyRuntimeProcessState(
        [
          "pid1=entrypoint",
          "agent=absent",
          "entrypoint=present",
          "tailscale_up=present",
          "force_noise_443=enabled",
          "stuck_cli_escape=present",
        ].join("\n"),
      ),
    ).toEqual({
      pid1: "entrypoint",
      agentProcessPresent: false,
      entrypointProcessPresent: true,
      tailscaleUpProcessPresent: true,
      forceNoise443Enabled: true,
      stuckCliEscapePresent: true,
    });
  });

  test("fails closed for missing or unrecognized process facts", () => {
    expect(
      classifyRuntimeProcessState("pid1=private-command\nagent=present"),
    ).toEqual({
      pid1: "unknown",
      agentProcessPresent: true,
      entrypointProcessPresent: false,
      tailscaleUpProcessPresent: false,
      forceNoise443Enabled: false,
      stuckCliEscapePresent: false,
    });
  });

  test("marks an observation that never happened as an error", () => {
    // `observe()` returns exactly this for any failure, including a
    // `docker exec` against a container that is not running.
    const failed = withObservationQuery(
      { ok: false, output: "" },
      classifyRuntimeProcessState,
    );

    expect(failed.query).toBe("error");
    // The classified facts are still all-false, which is precisely why the
    // discriminator has to be there: without it this is indistinguishable
    // from a live container whose entrypoint and agent are both gone.
    expect(failed.agentProcessPresent).toBe(false);
    expect(failed.entrypointProcessPresent).toBe(false);
  });

  test("keeps a successful observation's facts intact", () => {
    const observed = withObservationQuery(
      {
        ok: true,
        output: ["pid1=entrypoint", "entrypoint=present", "agent=absent"].join(
          "\n",
        ),
      },
      classifyRuntimeProcessState,
    );

    expect(observed).toEqual({
      query: "success",
      pid1: "entrypoint",
      agentProcessPresent: false,
      entrypointProcessPresent: true,
      tailscaleUpProcessPresent: false,
      forceNoise443Enabled: false,
      stuckCliEscapePresent: false,
    });
  });

  test("the observation's own query is not shadowed by a classifier's", () => {
    // classifyTailscaleStatus reports a `query` of its own, from a parse
    // failure rather than a failed observation. If a caller ever routes a
    // classifier like that through here, the observation-level answer is the
    // one the artifact promises.
    const shadowed = withObservationQuery({ ok: false, output: "" }, () => ({
      query: "success" as const,
      backendState: null,
    }));

    expect(shadowed.query).toBe("error");
    expect(shadowed.backendState).toBeNull();
  });

  test("discriminates empty container logs from unread ones", () => {
    // A container that started cleanly and logged nothing matching, versus a
    // `docker logs` that never ran. Same four booleans; different query.
    const read = withObservationQuery(
      { ok: true, output: "" },
      classifyContainerLogs,
    );
    const unread = withObservationQuery(
      { ok: false, output: "" },
      classifyContainerLogs,
    );

    expect(read.query).toBe("success");
    expect(unread.query).toBe("error");
    expect({ ...read, query: null }).toEqual({ ...unread, query: null });
  });

  // `run()` needs a live SSH client, so the call sites that assemble the
  // published artifact cannot be exercised here. Pin them against the source
  // instead: a classifier that reaches the artifact without passing through
  // `withObservationQuery` is the whole defect, and it would otherwise be
  // invisible to every test in this file.
  describe("the emitted artifact's observation call sites", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(
      path.join(here, "managed-dedicated-mesh-state-diagnostic.ts"),
      "utf8",
    );
    const repoRoot = path.resolve(here, "../../../..");
    const workflow = readFileSync(
      path.join(repoRoot, ".github/workflows/live-smoke.yml"),
      "utf8",
    );

    test("both classifiers are wrapped, and neither is called bare", () => {
      expect(source).toMatch(
        /withObservationQuery\(\s*logs\s*,\s*classifyContainerLogs\s*[,)]/,
      );
      expect(source).toMatch(
        /withObservationQuery\(\s*runtime\s*,\s*classifyRuntimeProcessState\s*[,)]/,
      );
      expect(source).not.toContain("classifyContainerLogs(logs.output)");
      expect(source).not.toContain(
        "classifyRuntimeProcessState(runtime.output)",
      );
    });

    test("the live-smoke contract accepts the discriminators it will receive", () => {
      // A schema the emitter produces but the workflow's jq rejects fails at
      // canary time, not in CI, so keep the two ends pinned to each other.
      expect(source).toContain("schemaVersion: 3,");
      expect(workflow).toContain(".schemaVersion == 3 and");
      for (const field of [".runtime.query", ".logs.query"]) {
        expect(workflow).toContain(
          `(${field} == "success" or ${field} == "error")`,
        );
      }
    });
  });
});
