/** Exercises early Docker mesh-join classification with deterministic evidence. */
import { describe, expect, test } from "bun:test";
import {
  classifyDockerMeshJoinProbe,
  requiredHeadscaleIngressFailure,
} from "./docker-sandbox-provider";
import { jobErrorText } from "./job-error-text";

describe("classifyDockerMeshJoinProbe", () => {
  test.each([
    "[docker-entrypoint] tailscale requires interactive authorization (AuthURL/NeedsLogin); unattended mesh join rejected",
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
