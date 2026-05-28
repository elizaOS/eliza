import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertRemotePluginPayload,
  type RemotePluginWorkerMessage,
} from "@elizaos/plugin-remote-manifest";
import { describe, expect, it } from "vitest";
import {
  getFirstPartyRemotePluginDefinitions,
  isFirstPartyRemotePluginDisabled,
  seedFirstPartyRemotePlugins,
  setFirstPartyRemotePluginDisabled,
} from "./first-party-remotes";
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
        start: (remotePlugin) => {
          const worker = new FakeWorkerHandle();
          workers.set(remotePlugin.manifest.id, worker);
          return worker;
        },
      },
    });
    return fn(manager);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("first-party RemotePlugins", () => {
  it("validates bundled manifests", () => {
    const manifests = getFirstPartyRemotePluginDefinitions({
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
    expect(
      manifests.find((manifest) => manifest.id === "eliza.runtime")
        ?.permissions.isolation,
    ).toBe("shared-worker");
  });

  it("skips first-party RemotePlugins when packaged resources omit remotes", () =>
    withTempManager((manager) => {
      const missingRoot = join(manager.getStoreRoot(), "missing-remotes");

      expect(
        getFirstPartyRemotePluginDefinitions({
          includeDev: true,
          rootDir: missingRoot,
        }),
      ).toEqual([]);
      expect(
        seedFirstPartyRemotePlugins({
          manager,
          includeDev: true,
          rootDir: missingRoot,
          startAutoStart: true,
        }),
      ).toEqual([]);
    }));

  it("seeds first-party RemotePlugins idempotently and starts auto-start entries", () =>
    withTempManager((manager) => {
      const first = seedFirstPartyRemotePlugins({ manager, includeDev: true });
      const second = seedFirstPartyRemotePlugins({ manager, includeDev: true });

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
      setFirstPartyRemotePluginDisabled("eliza.runtime", true, manager);

      const results = seedFirstPartyRemotePlugins({
        manager,
        includeDev: false,
      });
      const runtime = results.find((result) => result.id === "eliza.runtime");

      expect(isFirstPartyRemotePluginDisabled("eliza.runtime", manager)).toBe(
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
