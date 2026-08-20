/**
 * Verifies identical state across scenario-runner and Cloud bootstrap wires and
 * exercises the transport-neutral sidecar control boundary.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  bootWorldFromEnvironment,
  bootWorldFromProcessBootstrap,
  createProcessBootstrap,
  processBootstrapEnvironment,
  SyntheticWorldControlAdapter,
  serializeProcessBootstrap,
} from "./adapters.ts";
import { testManifest } from "./test-fixture.ts";

describe("synthetic-world process adapters", () => {
  it("boots scenario-runner and Cloud profiles from the same canonical manifest", () => {
    const manifest = testManifest();
    const scenarioBootstrap = createProcessBootstrap(
      manifest,
      "scenario-runner",
      { namespace: "world:scenario:one" },
    );
    const cloudBootstrap = createProcessBootstrap(manifest, "cloud-e2e", {
      namespace: "world:cloud:one",
    });
    expect(scenarioBootstrap.manifestHash).toBe(cloudBootstrap.manifestHash);
    const scenario = bootWorldFromProcessBootstrap(
      serializeProcessBootstrap(scenarioBootstrap),
    );
    const cloud = bootWorldFromEnvironment(
      processBootstrapEnvironment(cloudBootstrap),
    );
    expect(scenario.stateHash).toBe(cloud.stateHash);
    expect(scenario.clock.nowIso()).toBe(cloud.clock.nowIso());
    scenario.teardown();
    cloud.teardown();
  });

  it("reproduces the same state hash in an isolated process", () => {
    const bootstrap = createProcessBootstrap(
      testManifest(),
      "scenario-runner",
      {
        namespace: "world:subprocess:one",
      },
    );
    const encoded = serializeProcessBootstrap(bootstrap);
    const script = `
      import { bootWorldFromProcessBootstrap } from "./src/index.ts";
      const world = bootWorldFromProcessBootstrap(process.argv[1]);
      process.stdout.write(world.stateHash);
      world.teardown();
    `;
    const subprocessHash = execFileSync("bun", ["--eval", script, encoded], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const world = bootWorldFromProcessBootstrap({
      ...bootstrap,
      namespace: "world:subprocess:parent",
    });
    expect(subprocessHash).toBe(world.stateHash);
    world.teardown();
  });

  it("rejects bootstrap drift and unsupported wire versions", () => {
    const bootstrap = createProcessBootstrap(testManifest(), "cloud-e2e", {
      namespace: "world:drift:one",
    });
    const drifted = { ...bootstrap, manifestHash: "0".repeat(64) };
    expect(() => bootWorldFromProcessBootstrap(drifted)).toThrow(
      /hash mismatch/,
    );
    const unsupported = Buffer.from(
      JSON.stringify({ ...bootstrap, bootstrapVersion: "2" }),
    ).toString("base64url");
    expect(() => bootWorldFromProcessBootstrap(unsupported)).toThrow(
      /Unsupported/,
    );
  });

  it("exposes reset, snapshot, restore, time, state, and ledger controls", async () => {
    const bootstrap = createProcessBootstrap(testManifest(), "cloud-e2e", {
      namespace: "world:control:one",
    });
    const world = bootWorldFromProcessBootstrap(bootstrap);
    const control = new SyntheticWorldControlAdapter(world);
    const initial = await control.handle({ operation: "state" });
    const snapshotResponse = await control.handle({ operation: "snapshot" });
    if (snapshotResponse.operation !== "snapshot")
      throw new Error("Expected snapshot response");
    const advanced = await control.handle({
      operation: "advanceBy",
      durationMs: 1_000,
    });
    expect(advanced).toMatchObject({
      operation: "advanceBy",
      callbacks: 0,
      now: "2030-01-01T08:00:01.000Z",
    });
    await control.handle({
      operation: "restore",
      snapshot: snapshotResponse.snapshot,
    });
    expect(await control.handle({ operation: "state" })).toEqual(initial);
    expect(await control.handle({ operation: "ledger" })).toEqual({
      operation: "ledger",
      entries: [],
    });
    await control.handle({ operation: "reset" });
    world.teardown();
  });
});
