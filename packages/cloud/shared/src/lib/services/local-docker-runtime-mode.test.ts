/**
 * Guards the local-Docker-only pairing relay opt-in without starting Docker.
 */
import { describe, expect, test } from "bun:test";
import { applyLocalDockerRuntimeMode } from "./local-docker-runtime-mode";

describe("local Docker runtime mode", () => {
  test("forces direct pairing on only after caller environment values", () => {
    const result = applyLocalDockerRuntimeMode({
      KEEP: "value",
      ELIZA_CLOUD_PROVISIONED: "0",
      ELIZA_CLOUD_PAIR_DIRECT_RELAY: "0",
    });

    expect(result).toMatchObject({
      KEEP: "value",
      ELIZA_CLOUD_PROVISIONED: "1",
      ELIZA_CLOUD_PAIR_DIRECT_RELAY: "1",
    });
  });

  test("moves the managed root PGlite path under the image runtime user", () => {
    expect(applyLocalDockerRuntimeMode({ PGLITE_DATA_DIR: "/root/.eliza/.pgdata" })).toMatchObject({
      PGLITE_DATA_DIR: "/home/agent/.eliza/.pgdata",
    });
    expect(applyLocalDockerRuntimeMode({ PGLITE_DATA_DIR: "/custom/pgdata" })).toMatchObject({
      PGLITE_DATA_DIR: "/custom/pgdata",
    });
  });
});
