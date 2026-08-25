import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

const cryptoMock = vi.hoisted(() => ({
  randomBytes: vi.fn(() => Buffer.from([0xab, 0xcd, 0xef])),
}));

const osMock = vi.hoisted(() => ({
  hostname: vi.fn(() => "laptop-01"),
  platform: vi.fn(() => "linux"),
  networkInterfaces: vi.fn(() => ({})),
}));

const agentMock = vi.hoisted(() => ({
  resolveStateDir: vi.fn(() => "/state/dir"),
}));

vi.mock("node:fs", () => ({ default: fsMock, ...fsMock }));
vi.mock("node:crypto", () => ({ default: cryptoMock, ...cryptoMock }));
vi.mock("node:os", () => ({ default: osMock, ...osMock }));
vi.mock("@elizaos/agent", () => agentMock);
vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  return { default: actual, ...actual };
});

import {
  getDeviceFingerprint,
  getDeviceId,
  resetCachedDeviceId,
} from "./device-identity";

const EMPTY_ENV = {};

describe("device identity", () => {
  beforeEach(() => {
    resetCachedDeviceId();
    fsMock.existsSync.mockReset();
    fsMock.readFileSync.mockReset();
    fsMock.mkdirSync.mockReset();
    fsMock.writeFileSync.mockReset();
    fsMock.existsSync.mockReturnValue(false);
    osMock.hostname.mockReturnValue("laptop-01");
    osMock.networkInterfaces.mockReturnValue({});
    agentMock.resolveStateDir.mockReturnValue("/state/dir");
  });

  it("honors a non-empty ELIZA_DEVICE_ID env override (trimmed)", () => {
    expect(getDeviceId({ ELIZA_DEVICE_ID: "  id-from-env  " })).toBe(
      "id-from-env",
    );
    expect(fsMock.existsSync).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only env value as unset and falls through to the file", () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue("cached-id");
    expect(getDeviceId({ ELIZA_DEVICE_ID: "   " })).toBe("cached-id");
  });

  it("reads a persisted id from the state dir when no env override exists", () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue("  file-id\n");
    expect(getDeviceId(EMPTY_ENV)).toBe("file-id");
    expect(fsMock.readFileSync).toHaveBeenCalledWith(
      "/state/dir/device-id",
      "utf8",
    );
  });

  it("ignores an empty cache file and generates a fresh id", () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue("   ");
    osMock.hostname.mockReturnValue("laptop-01");
    const id = getDeviceId(EMPTY_ENV);
    expect(id).toBe("laptop-01-abcdef");
  });

  it("sanitizes the hostname into the generated id and persists it", () => {
    osMock.hostname.mockReturnValue("My 🚀 Host!");
    const id = getDeviceId(EMPTY_ENV);
    // Non-BMP characters (surrogate pairs) are sanitized per UTF-16 code unit,
    // so the emoji collapses to two hyphens — the current documented behavior
    // of the guard: the id stays within [A-Za-z0-9._-].
    expect(id).toBe("My----Host--abcdef");
    expect(fsMock.mkdirSync).toHaveBeenCalledWith("/state/dir", {
      recursive: true,
    });
    expect(fsMock.writeFileSync).toHaveBeenCalledWith(
      "/state/dir/device-id",
      id,
      "utf8",
    );
  });

  it("keeps the id charset-safe when the hostname is punctuation-only", () => {
    // "!!!" sanitizes to "---" (non-empty), so the 'host' fallback does not
    // fire — the guard only guarantees the [A-Za-z0-9._-] charset, not
    // human-readable output.
    osMock.hostname.mockReturnValue("!!!");
    expect(getDeviceId(EMPTY_ENV)).toBe("----abcdef");
  });

  it("falls back to the literal 'host' when the hostname is empty", () => {
    osMock.hostname.mockReturnValue("");
    expect(getDeviceId(EMPTY_ENV)).toBe("host-abcdef");
  });

  it("memoizes the resolved id for the process lifetime", () => {
    expect(getDeviceId({ ELIZA_DEVICE_ID: "first" })).toBe("first");
    expect(getDeviceId({ ELIZA_DEVICE_ID: "second" })).toBe("first");
  });

  it("re-resolves after resetCachedDeviceId drops the memo", () => {
    expect(getDeviceId({ ELIZA_DEVICE_ID: "first" })).toBe("first");
    resetCachedDeviceId();
    expect(getDeviceId({ ELIZA_DEVICE_ID: "second" })).toBe("second");
  });

  it("excludes internal and zeroed interfaces from the MAC fingerprint", () => {
    osMock.networkInterfaces.mockReturnValue({
      lo: [{ internal: true, mac: "00:00:00:00:00:00" }],
      eth0: [{ internal: false, mac: "00:00:00:00:00:00" }],
      wlan0: [{ internal: false, mac: "aa:bb:cc:dd:ee:ff" }],
    });
    const fp = getDeviceFingerprint({ ELIZA_DEVICE_ID: "fp-id" });
    expect(fp.id).toBe("fp-id");
    expect(fp.hostname).toBe("laptop-01");
    expect(fp.platform).toBe("linux");
    expect(fp.primaryMacAddress).toBe("aa:bb:cc:dd:ee:ff");
  });

  it("reports null MAC when every interface is internal or zeroed", () => {
    osMock.networkInterfaces.mockReturnValue({
      lo: [{ internal: true, mac: "aa:bb:cc:dd:ee:ff" }],
      eth0: [{ internal: false, mac: "00:00:00:00:00:00" }],
    });
    expect(getDeviceFingerprint(EMPTY_ENV).primaryMacAddress).toBeNull();
  });
});
