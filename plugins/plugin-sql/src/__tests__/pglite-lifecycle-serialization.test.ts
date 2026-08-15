/**
 * Proves the production PGlite manager serializes data-directory snapshots
 * with client teardown so neither operation can observe a half-closed handle.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { PGliteClientManager } from "../pglite/manager";

describe("PGlite snapshot lifecycle serialization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lets an admitted dump finish before close reaches the client", async () => {
    const manager = new PGliteClientManager({ dataDir: "memory://" });
    const client = manager.getConnection();
    let releaseDump!: (value: Blob) => void;
    const dumpSpy = vi.spyOn(client, "dumpDataDir").mockImplementation(
      async () =>
        await new Promise<Blob>((resolve) => {
          releaseDump = resolve;
        })
    );
    const closeSpy = vi.spyOn(client, "close").mockResolvedValue(undefined);

    const dumpPromise = manager.dumpDataDir("gzip");
    const closePromise = manager.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(dumpSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).not.toHaveBeenCalled();

    releaseDump(new Blob(["snapshot"]));
    await expect(dumpPromise).resolves.toBeInstanceOf(Blob);
    await expect(closePromise).resolves.toBeUndefined();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects a dump admitted after close without touching the client", async () => {
    const manager = new PGliteClientManager({ dataDir: "memory://" });
    const client = manager.getConnection();
    const dumpSpy = vi.spyOn(client, "dumpDataDir");
    const closeSpy = vi.spyOn(client, "close").mockResolvedValue(undefined);

    const closePromise = manager.close();
    await expect(manager.dumpDataDir("gzip")).rejects.toThrow("PGlite is closing");
    await expect(closePromise).resolves.toBeUndefined();
    expect(dumpSpy).not.toHaveBeenCalled();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
