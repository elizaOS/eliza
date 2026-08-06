import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const RELEASE_URL = "https://api.github.com/repos/superagent-ai/grok-cli/releases/latest";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

async function importModule() {
  return import("./update-checker");
}

describe("checkForUpdate", () => {
  it("returns hasUpdate=true when release version is newer", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ tag_name: "v2.0.0", assets: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { checkForUpdate } = await importModule();
    const result = await checkForUpdate("1.0.0");

    expect(result).not.toBeNull();
    expect(result!.hasUpdate).toBe(true);
    expect(result!.latestVersion).toBe("2.0.0");
    expect(result!.currentVersion).toBe("1.0.0");
    expect(mockFetch).toHaveBeenCalledWith(
      RELEASE_URL,
      expect.objectContaining({ headers: { Accept: "application/vnd.github+json" } }),
    );
  });

  it("returns hasUpdate=false when current version matches latest", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tag_name: "v1.0.0", assets: [] }),
      }),
    );

    const { checkForUpdate } = await importModule();
    const result = await checkForUpdate("1.0.0");

    expect(result).not.toBeNull();
    expect(result!.hasUpdate).toBe(false);
  });

  it("detects update from prerelease to stable release", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tag_name: "v1.0.0", assets: [] }),
      }),
    );

    const { checkForUpdate } = await importModule();
    const result = await checkForUpdate("1.0.0-rc7");

    expect(result).not.toBeNull();
    expect(result!.hasUpdate).toBe(true);
    expect(result!.latestVersion).toBe("1.0.0");
    expect(result!.currentVersion).toBe("1.0.0-rc7");
  });

  it("returns hasUpdate=false when prerelease is newer than registry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tag_name: "v0.9.0", assets: [] }),
      }),
    );

    const { checkForUpdate } = await importModule();
    const result = await checkForUpdate("1.0.0-rc7");

    expect(result).not.toBeNull();
    expect(result!.hasUpdate).toBe(false);
  });

  it("returns null when the fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    const { checkForUpdate } = await importModule();
    const result = await checkForUpdate("1.0.0");

    expect(result).toBeNull();
  });

  it("returns null when the release API returns a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    const { checkForUpdate } = await importModule();
    const result = await checkForUpdate("1.0.0");

    expect(result).toBeNull();
  });

  it("returns null when the release API returns an invalid version", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tag_name: "not-a-version", assets: [] }),
      }),
    );

    const { checkForUpdate } = await importModule();
    const result = await checkForUpdate("1.0.0");

    expect(result).toBeNull();
  });

  it("returns null when the current version is invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tag_name: "v2.0.0", assets: [] }),
      }),
    );

    const { checkForUpdate } = await importModule();
    const result = await checkForUpdate("garbage");

    expect(result).toBeNull();
  });

  it("handles fetch timeout gracefully", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error("aborted")), 10))),
    );

    const { checkForUpdate } = await importModule();
    const result = await checkForUpdate("1.0.0");

    expect(result).toBeNull();
  });
});

describe("runUpdate", () => {
  it("returns success when the script-managed updater succeeds", async () => {
    vi.doMock("./install-manager", async () => {
      const actual = await vi.importActual<typeof import("./install-manager")>("./install-manager");
      return {
        ...actual,
        runScriptManagedUpdate: vi.fn().mockResolvedValue({ success: true, output: "Updated to Grok 2.0.0." }),
      };
    });

    const { runUpdate } = await importModule();
    const result = await runUpdate("1.0.0");

    expect(result.success).toBe(true);
    expect(result.output).toContain("Updated");
  });

  it("returns failure when the script-managed updater fails", async () => {
    vi.doMock("./install-manager", async () => {
      const actual = await vi.importActual<typeof import("./install-manager")>("./install-manager");
      return {
        ...actual,
        runScriptManagedUpdate: vi.fn().mockResolvedValue({ success: false, output: "permission denied" }),
      };
    });

    const { runUpdate } = await importModule();
    const result = await runUpdate("1.0.0");

    expect(result.success).toBe(false);
    expect(result.output).toContain("permission denied");
  });
});
