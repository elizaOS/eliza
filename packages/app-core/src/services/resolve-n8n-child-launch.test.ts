import { describe, expect, it, vi } from "vitest";
import {
  N8N_DEFAULT_PACKAGE_LAUNCHER,
  resolveBundledN8nCliPath,
  resolveN8nChildLaunch,
} from "./resolve-n8n-child-launch";

describe("resolveN8nChildLaunch", () => {
  it("uses npx when default binary and npx is on PATH", async () => {
    const probe = vi.fn(async (b: string) => b === "npx");
    const r = await resolveN8nChildLaunch({
      configuredBinary: N8N_DEFAULT_PACKAGE_LAUNCHER,
      pinnedVersion: "1.70.0",
      probe,
    });
    expect(r.command).toBe("npx");
    expect(r.args).toEqual(["--yes", "n8n@1.70.0", "start"]);
    expect(probe).toHaveBeenCalledWith("npx");
    expect(probe).not.toHaveBeenCalledWith("node");
  });

  it("uses explicit bunx without probing npx", async () => {
    const probe = vi.fn();
    const r = await resolveN8nChildLaunch({
      configuredBinary: "bunx",
      pinnedVersion: "1.70.0",
      probe,
    });
    expect(r.command).toBe("bunx");
    expect(r.args).toEqual(["--", "n8n@1.70.0", "start"]);
    expect(probe).not.toHaveBeenCalled();
  });

  it("probes node when npx is missing and bundled n8n is resolvable", async () => {
    if (!resolveBundledN8nCliPath()) {
      return;
    }
    const probe = vi.fn(async (b: string) => {
      if (b === "npx") return false;
      if (b === "node") return true;
      return false;
    });
    const r = await resolveN8nChildLaunch({
      configuredBinary: N8N_DEFAULT_PACKAGE_LAUNCHER,
      pinnedVersion: "1.100.0",
      probe,
    });
    expect(r.command).toBe("node");
    expect(r.args[0]).toMatch(/n8n/);
    expect(r.args[r.args.length - 1]).toBe("start");
    expect(probe).toHaveBeenCalledWith("npx");
    expect(probe).toHaveBeenCalledWith("node");
  });

  it("throws when npx missing and bundled n8n or node unavailable", async () => {
    const probe = vi.fn(async () => false);
    await expect(
      resolveN8nChildLaunch({
        configuredBinary: N8N_DEFAULT_PACKAGE_LAUNCHER,
        pinnedVersion: "1.100.0",
        probe,
      }),
    ).rejects.toThrow(/Local n8n needs either `npx`/);
  });
});
