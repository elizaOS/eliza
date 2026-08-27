/** Exercises early Docker mesh-join classification with deterministic evidence. */
import { describe, expect, test } from "bun:test";
import { classifyDockerMeshJoinProbe } from "./docker-sandbox-provider";

describe("classifyDockerMeshJoinProbe", () => {
  test("terminates a running candidate that entered interactive Headscale auth", () => {
    expect(
      classifyDockerMeshJoinProbe(`state=running exit=0
{
  "AuthURL": "https://headscale.example.test/register/test-node",
  "BackendState": "NeedsLogin"
}`),
    ).toEqual({
      status: "terminal",
      reason: "auth_required",
      containerState: "running",
      exitCode: 0,
    });
  });

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
