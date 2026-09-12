/**
 * Executes the workflow's real shell and jq diagnostic against controlled
 * Tailscale responses, without contacting a host or exposing peer identities.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import {
  classifyApplicationState,
  classifyContainerLogs,
  classifyHostRuntimeState,
  classifyRuntimeProcessState,
  classifyTailscaleStatus,
} from "./managed-dedicated-mesh-state-diagnostic";

interface DiagnosticWorkflow {
  jobs: {
    "dedicated-diagnostic": {
      steps: Array<{ name: string; with?: { script?: string } }>;
    };
  };
}

const workflow = parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      "../../../../.github/workflows/live-smoke.yml",
    ),
    "utf8",
  ),
) as DiagnosticWorkflow;
const script = workflow.jobs["dedicated-diagnostic"].steps.find(
  (step) => step.name === "Inspect control-plane route to exact canary peer",
)?.with?.script;
if (!script) throw new Error("Missing control-plane diagnostic shell");

function diagnose(status: string, statusExit = 0) {
  return spawnSync(
    "bash",
    [
      "-c",
      `
sudo() { printf '%s' "$TEST_TAILSCALE_STATUS"; return "$TEST_TAILSCALE_EXIT"; }
ip() { printf '100.64.0.42 dev tailscale0\n'; }
timeout() { return 1; }
curl() { printf '503'; }
${script}`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CANARY_HEADSCALE_IP: "100.64.0.42",
        CANARY_DIAGNOSTIC_SUFFIX: "r12345678a1",
        TEST_TAILSCALE_STATUS: status,
        TEST_TAILSCALE_EXIT: String(statusExit),
      },
      timeout: 10_000,
    },
  );
}

function peerStatus(addresses: string[]) {
  return JSON.stringify({
    BackendState: "Running",
    Self: { TailscaleIPs: ["100.64.0.10"] },
    Peer: {
      peer1: {
        HostName: "managed-dedicated-canary-r12345678a1",
        TailscaleIPs: addresses,
        Online: true,
      },
    },
  });
}

describe("control-plane Tailscale diagnostic", () => {
  test.each([
    ["fd7a:115c:a1e0::42", "100.64.0.42"],
    ["100.64.0.42", "fd7a:115c:a1e0::42", "100.64.0.42"],
  ])(
    "uses the unique CGNAT address regardless of ordering: %j",
    (...addresses) => {
      const result = diagnose(peerStatus(addresses));
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "control_plane_suffix_ip_matches_database=true",
      );
      expect(result.stdout).toContain(
        "control_plane_suffix_route_tailscale0=true",
      );
      expect(result.stdout).not.toContain("100.64.0.42");
    },
  );

  test.each([
    ["fd7a:115c:a1e0::42"],
    ["100.64.0.42", "100.64.0.43"],
    ["100.64.999.42"],
  ])(
    "does not probe an absent, ambiguous, or invalid suffix address: %j",
    (...addresses) => {
      const result = diagnose(peerStatus(addresses));
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "control_plane_suffix_ip_matches_database=false",
      );
      expect(result.stdout).toContain(
        "control_plane_suffix_route_tailscale0=false",
      );
    },
  );

  test.each(["", "not json", "[]", '{"Peer":[]}'])(
    "reports unavailable status instead of a healthy zero count: %j",
    (status) => {
      const result = diagnose(status);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe(
        "control_plane_tailnet_observation=unavailable\n",
      );
    },
  );

  test("does not trust partial status from a failed command", () => {
    const result = diagnose(peerStatus(["100.64.0.42"]), 1);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe(
      "control_plane_tailnet_observation=unavailable\n",
    );
  });

  test("the workflow publishes unavailable host observations distinctly from observed false", () => {
    const meshScript = workflow.jobs["dedicated-diagnostic"].steps.find(
      (step) => step.name === "Inspect exact private mesh candidate",
    )?.with?.script;
    if (!meshScript) throw new Error("Missing mesh diagnostic consumer");
    const diagnostic = {
      schemaVersion: 4,
      targetCount: 1,
      host: classifyHostRuntimeState(
        "live_restore=unknown\ndocker_service=inactive",
      ),
      application: classifyApplicationState(""),
      container: {
        inspect: "error",
        status: "unknown",
        exitCode: null,
        health: "unknown",
        imageMatchesConfigured: null,
      },
      tailscale: {
        ...classifyTailscaleStatus(""),
        socketPresent: false,
        daemonPresent: false,
        ipPresent: false,
      },
      runtime: classifyRuntimeProcessState(""),
      logs: classifyContainerLogs(""),
    };
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
timeout() { printf 'MESH_DIAGNOSTIC=%s\\n' "$TEST_MESH"; }
${meshScript}`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          TEST_MESH: JSON.stringify(diagnostic),
          CANARY_DIAGNOSTIC_SUFFIX: "r12345678a1",
        },
        timeout: 10_000,
      },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("private_mesh_host_live_restore=null");
    expect(result.stdout).toContain(
      "private_mesh_host_docker_service_active=false",
    );
    expect(result.stdout).toContain(
      "private_mesh_application_cloud_provisioned=null",
    );
  });

  test("does not attribute another agent's recent recovery stage to the selected canary", () => {
    const journalScript = workflow.jobs["dedicated-diagnostic"].steps.find(
      (step) => step.name === "Classify exact dedicated lifecycle journal",
    )?.with?.script;
    if (!journalScript) throw new Error("Missing lifecycle journal consumer");
    const canary = "11111111-1111-4111-8111-111111111111";
    const journal = [
      "[docker-sandbox] Docker daemon recovery did not prove container removal",
      `agentId: ${canary}`,
      "recoveryStage: exact_container_remove",
      ...Array.from({ length: 30 }, () => "unrelated journal separator"),
      "[docker-sandbox] Docker daemon recovery did not prove container removal",
      "agentId: 22222222-2222-4222-8222-222222222222",
      "recoveryStage: live_restore_proof",
    ].join("\n");
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
sudo() { if [ "$1" = journalctl ]; then printf '%s\\n' "$TEST_JOURNAL"; else return 1; fi; }
${journalScript}`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          TEST_JOURNAL: journal,
          CANARY_AGENT_ID: canary,
          CANARY_DELETE_JOB_ID: "",
        },
        timeout: 10_000,
      },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "dedicated_docker_recovery_failure_stage=exact_container_remove",
    );
    expect(result.stdout).not.toContain(canary);
  });
});
