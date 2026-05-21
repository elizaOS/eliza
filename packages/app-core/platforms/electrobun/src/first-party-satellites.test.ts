import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemotePluginWorkerMessage } from "@elizaos/plugin-remote-manifest";
import { assertRemotePluginPayload } from "@elizaos/plugin-remote-manifest";
import { describe, expect, it } from "vitest";
import {
  getFirstPartySatelliteDefinitions,
  isFirstPartySatelliteDisabled,
  seedFirstPartySatellites,
  setFirstPartySatelliteDisabled,
} from "./first-party-satellites";
import {
  RemotePluginHost,
  type RemotePluginWorkerHandle,
} from "./native/remote-plugin-host";

class FakeWorkerHandle implements RemotePluginWorkerHandle {
  readonly messages: RemotePluginWorkerMessage[] = [];
  terminated = false;
  private messageListener:
    | ((message: RemotePluginWorkerMessage) => void)
    | null = null;
  private errorListener: ((error: Error) => void) | null = null;

  postMessage(message: RemotePluginWorkerMessage): void {
    this.messages.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  onMessage(listener: (message: RemotePluginWorkerMessage) => void): void {
    this.messageListener = listener;
  }

  onError(listener: (error: Error) => void): void {
    this.errorListener = listener;
  }

  emit(message: RemotePluginWorkerMessage): void {
    this.messageListener?.(message);
  }

  fail(message: string): void {
    this.errorListener?.(new Error(message));
  }
}

function withTempManager<T>(fn: (manager: RemotePluginHost) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "electrobun-first-party-"));
  const workers = new Map<string, FakeWorkerHandle>();
  try {
    const manager = new RemotePluginHost({
      storeRoot: join(dir, "store"),
      now: () => 1700000000000,
      workerRunner: {
        start: (carrot) => {
          const worker = new FakeWorkerHandle();
          workers.set(carrot.manifest.id, worker);
          return worker;
        },
      },
    });
    return fn(manager);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("first-party Satellites", () => {
  it("validates bundled manifests", () => {
    const manifests = getFirstPartySatelliteDefinitions({
      includeDev: true,
    }).map((definition) => assertRemotePluginPayload(definition.sourceDir));

    expect(manifests.map((manifest) => manifest.id).sort()).toEqual([
      "eliza.fs",
      "eliza.git",
      "eliza.local-model",
      "eliza.pty",
      "eliza.runtime",
      "eliza.surface",
    ]);
  });

  it("seeds first-party Satellites idempotently and starts auto-start entries", () =>
    withTempManager((manager) => {
      const first = seedFirstPartySatellites({ manager, includeDev: true });
      const second = seedFirstPartySatellites({ manager, includeDev: true });

      expect(first.map((result) => result.action)).toEqual([
        "installed",
        "installed",
        "installed",
        "installed",
        "installed",
        "installed",
      ]);
      expect(second.map((result) => result.action)).toEqual([
        "unchanged",
        "unchanged",
        "unchanged",
        "unchanged",
        "unchanged",
        "unchanged",
      ]);
      expect(
        second
          .filter((result) => result.autoStarted)
          .map((result) => result.id)
          .sort(),
      ).toEqual(["eliza.fs", "eliza.local-model", "eliza.runtime"]);
      expect(manager.getRemotePlugin("eliza.runtime")?.currentHash).toBe(
        second.find((result) => result.id === "eliza.runtime")?.hash,
      );
    }));

  it("preserves explicit disabled state for auto-start entries", () =>
    withTempManager((manager) => {
      setFirstPartySatelliteDisabled("eliza.runtime", true, manager);

      const results = seedFirstPartySatellites({ manager, includeDev: false });
      const runtime = results.find((result) => result.id === "eliza.runtime");

      expect(isFirstPartySatelliteDisabled("eliza.runtime", manager)).toBe(
        true,
      );
      expect(runtime).toMatchObject({
        id: "eliza.runtime",
        disabled: true,
        autoStarted: false,
      });
      expect(manager.getWorkerStatus("eliza.runtime")).toMatchObject({
        id: "eliza.runtime",
        state: "stopped",
      });
    }));
});
