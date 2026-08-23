/**
 * Guards the local-Docker-only pairing relay opt-in without starting Docker.
 */
import { describe, expect, test } from "bun:test";
import { applyLocalDockerRuntimeMode } from "./local-docker-runtime-mode";

describe("local Docker runtime mode", () => {
  test("forces direct pairing on only after caller environment values", () => {
    const result = applyLocalDockerRuntimeMode(
      {
        KEEP: "value",
        ELIZA_CLOUD_PROVISIONED: "0",
        ELIZA_CLOUD_PAIR_DIRECT_RELAY: "0",
        ELIZA_CLOUD_PAIR_ALLOWED_PEER_CIDRS: "0.0.0.0/0",
      },
      "172.17.0.1/32",
      "http://host.docker.internal:18787/api/v1",
    );

    expect(result).toMatchObject({
      KEEP: "value",
      ELIZA_CLOUD_PROVISIONED: "1",
      ELIZA_CLOUD_PAIR_DIRECT_RELAY: "1",
      ELIZA_CLOUD_PAIR_ALLOWED_PEER_CIDRS: "172.17.0.1/32",
      ELIZAOS_CLOUD_BASE_URL: "http://host.docker.internal:18787/api/v1",
    });
  });
});
