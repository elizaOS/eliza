import { expect, test } from "bun:test";
import { agentCpuUnitsToDockerCpus, buildAgentContainerCpuFlags } from "./agent-container-security";

test("an explicit per-agent cpu always yields a ceiling, never a disabled one", () => {
  // 1..5 units divide to under 0.005 vCPU, which the flag builder rounds to 0,
  // and `--cpus 0` is "no limit" to Docker.
  for (const units of [1, 5, 6, 15, 102]) {
    expect(buildAgentContainerCpuFlags(agentCpuUnitsToDockerCpus(units))).toEqual(["--cpus '0.1'"]);
  }
  expect(buildAgentContainerCpuFlags(agentCpuUnitsToDockerCpus(1024))).toEqual(["--cpus '1'"]);
  expect(buildAgentContainerCpuFlags(agentCpuUnitsToDockerCpus(1792))).toEqual(["--cpus '1.75'"]);
  expect(agentCpuUnitsToDockerCpus(undefined)).toBeUndefined();
});
