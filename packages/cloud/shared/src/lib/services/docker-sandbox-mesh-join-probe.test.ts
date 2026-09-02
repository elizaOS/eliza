/** Exercises early Docker mesh-join classification with deterministic evidence. */
import { describe, expect, test } from "bun:test";
import {
  classifyDockerMeshJoinObservation,
  classifyDockerMeshJoinProbe,
  formatDockerMeshJoinObservation,
  probeDockerMeshJoinTerminalFailure,
  requiredHeadscaleIngressFailure,
} from "./docker-sandbox-provider";
import { jobErrorText } from "./job-error-text";

describe("classifyDockerMeshJoinProbe", () => {
  test.each([
    "[docker-entrypoint] tailscale requires interactive authorization (AuthURL/NeedsMachineAuth); unattended mesh join rejected",
    "[cloud-agent-entrypoint] FATAL: headscale auth key expired/rejected and no persisted identity could reconnect; node needs re-keying",
  ])("terminates a running candidate on its entrypoint-owned Headscale auth signal", (line) => {
    expect(classifyDockerMeshJoinProbe(`state=running exit=0\n${line}`)).toEqual({
      status: "terminal",
      reason: "auth_required",
      containerState: "running",
      exitCode: 0,
    });
  });

  test("terminates a running candidate on the entrypoint-owned marker", () => {
    expect(classifyDockerMeshJoinProbe("state=running exit=0\nauthkey-marker=present")).toEqual({
      status: "terminal",
      reason: "auth_required",
      containerState: "running",
      exitCode: 0,
    });
  });

  test("terminates a restarting candidate on the dedicated entrypoint exit code", () => {
    expect(classifyDockerMeshJoinProbe("state=restarting exit=78")).toEqual({
      status: "terminal",
      reason: "auth_required",
      containerState: "restarting",
      exitCode: 78,
    });
  });

  test.each(["plugin-openai: invalid key", "database: key expired", "interactive authorization"])(
    "keeps a healthy running candidate pending when app logs contain %s",
    (appLog) => {
      expect(classifyDockerMeshJoinProbe(`state=running exit=0\n${appLog}`)).toEqual({
        status: "pending",
      });
    },
  );

  test("keeps ordinary running and restarting candidates pending", () => {
    expect(
      classifyDockerMeshJoinProbe("state=running exit=0\ncontrol: waiting for network map"),
    ).toEqual({ status: "pending" });
    expect(
      classifyDockerMeshJoinProbe("state=restarting exit=1\ncontrol: temporary dial timeout"),
    ).toEqual({ status: "pending" });
  });

  test("terminates an exited candidate without requiring auth-specific logs", () => {
    expect(classifyDockerMeshJoinProbe("state=exited exit=137\nOOMKilled")).toEqual({
      status: "terminal",
      reason: "container_exited",
      containerState: "exited",
      exitCode: 137,
    });
  });
});

describe("Docker mesh-join observation", () => {
  test("records unavailable transport and accepts a later reconnect-backed observation", async () => {
    const failureKinds: string[] = [];
    const observations: ReturnType<typeof classifyDockerMeshJoinObservation>[] = [];
    const unavailableSsh = {
      exec: async () => {
        throw new Error("[docker-ssh] stream error on node: channel closed");
      },
    };

    expect(
      await probeDockerMeshJoinTerminalFailure(
        unavailableSsh,
        "a".repeat(64),
        (observation) => observations.push(observation),
        (kind) => failureKinds.push(kind),
      ),
    ).toBeNull();
    expect(failureKinds).toEqual(["transport"]);
    expect(observations).toEqual([]);

    const reconnectedSsh = {
      exec: async () =>
        [
          "state=running exit=0",
          "__eliza_mesh_probe_section__=socket",
          "socket=present",
          "daemon=present",
          "__eliza_mesh_probe_section__=status",
          JSON.stringify({
            BackendState: "Running",
            Self: { MachineAuthorized: true },
          }),
          "__eliza_mesh_probe_section__=ip",
          "100.64.0.2",
          "__eliza_mesh_probe_section__=logs",
          "server started",
          "__eliza_mesh_probe_section__=daemonlog",
          "control_key=true",
          "login_started=true",
          "register_request=true",
          "control_transport_failed=false",
          "tls_failed=false",
          "dns_failed=false",
          "__eliza_mesh_probe_section__=network",
          "route=present",
          "tun=present",
          "control=reachable",
          "__eliza_mesh_probe_section__=end",
        ].join("\n"),
    };

    expect(
      await probeDockerMeshJoinTerminalFailure(
        reconnectedSsh,
        "a".repeat(64),
        (observation) => observations.push(observation),
        (kind) => failureKinds.push(kind),
      ),
    ).toBeNull();
    expect(failureKinds).toEqual(["transport"]);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      containerState: "running",
      socketPresent: true,
      daemonPresent: true,
      statusQuery: "success",
      backendState: "Running",
      machineAuthorized: true,
      ipPresent: true,
      defaultRoutePresent: true,
      tunPresent: true,
      headscaleReachable: true,
      controlKeyFetched: true,
      loginStarted: true,
      registerRequestSent: true,
      agentStarted: true,
    });
  });

  test("reduces raw Tailscale output and logs to closed diagnostic fields", () => {
    const raw = [
      "state=running exit=0",
      "authkey-marker=absent",
      "__eliza_mesh_probe_section__=socket",
      "socket=present",
      "daemon=present",
      "__eliza_mesh_probe_section__=status",
      JSON.stringify({
        BackendState: "NeedsLogin",
        AuthURL: "https://private.example/register/token",
        Self: { MachineAuthorized: false },
      }),
      "__eliza_mesh_probe_section__=ip",
      "",
      "__eliza_mesh_probe_section__=logs",
      "control: waiting for network map",
      "__eliza_mesh_probe_section__=daemonlog",
      "control_key=true",
      "login_started=true",
      "register_request=false",
      "control_transport_failed=false",
      "tls_failed=false",
      "dns_failed=false",
      "__eliza_mesh_probe_section__=network",
      "route=present",
      "tun=present",
      "control=unreachable",
      "__eliza_mesh_probe_section__=end",
    ].join("\n");

    const observation = classifyDockerMeshJoinObservation(raw);
    expect(observation).toEqual({
      containerState: "running",
      exitCode: 0,
      socketPresent: true,
      daemonPresent: true,
      statusQuery: "success",
      backendState: "NeedsLogin",
      machineAuthorized: false,
      authUrlPresent: true,
      ipPresent: false,
      defaultRoutePresent: true,
      tunPresent: true,
      headscaleReachable: false,
      controlKeyFetched: true,
      loginStarted: true,
      registerRequestSent: false,
      controlTransportFailed: false,
      tlsFailed: false,
      dnsFailed: false,
      authKeyRejected: false,
      interactiveAuthRequired: false,
      tailscaleUpFailed: false,
      agentStarted: false,
    });
    expect(formatDockerMeshJoinObservation(observation)).toBe(
      "container=running,exit=0,socket=true,daemon=true,status=success,backend=NeedsLogin,authorized=false,authurl=true,ip=false,route=true,tun=true,control=false,control_key=true,login_started=true,register_request=false,control_transport_failed=false,tls_failed=false,dns_failed=false,authkey_rejected=false,interactive=false,up_failed=false,agent_started=false",
    );
    expect(formatDockerMeshJoinObservation(observation)).not.toContain("private.example");
  });

  test("fails closed on malformed status and unrecognized state values", () => {
    const observation = classifyDockerMeshJoinObservation(
      [
        "state=private-state exit=0",
        "__eliza_mesh_probe_section__=socket",
        "socket=absent",
        "daemon=absent",
        "__eliza_mesh_probe_section__=status",
        "not-json",
        "__eliza_mesh_probe_section__=ip",
        "command failed",
        "__eliza_mesh_probe_section__=logs",
        "tailscale up failed",
        "__eliza_mesh_probe_section__=daemonlog",
        "control_key=false",
        "login_started=false",
        "register_request=false",
        "control_transport_failed=true",
        "tls_failed=false",
        "dns_failed=false",
        "__eliza_mesh_probe_section__=network",
        "route=absent",
        "tun=absent",
        "control=unreachable",
        "__eliza_mesh_probe_section__=end",
      ].join("\n"),
    );

    expect(observation.containerState).toBeNull();
    expect(observation.statusQuery).toBe("error");
    expect(observation.backendState).toBeNull();
    expect(observation.machineAuthorized).toBeNull();
    expect(observation.ipPresent).toBe(false);
    expect(observation.tailscaleUpFailed).toBe(true);
  });
});

describe("required Headscale ingress failure", () => {
  test("keeps the precise mesh failure reachable through durable job cause text", () => {
    const precise = new Error(
      "Docker candidate cannot complete required Headscale registration: auth_required",
    );
    const failure = requiredHeadscaleIngressFailure(
      "Headscale routing is required, but the sandbox did not register a headscale_ip.",
      [precise],
    );

    expect(jobErrorText(failure)).toContain(
      "caused by: Error: Docker candidate cannot complete required Headscale registration: auth_required",
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([precise]);
  });
});
