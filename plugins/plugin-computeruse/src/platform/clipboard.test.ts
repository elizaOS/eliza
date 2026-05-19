/**
 * Unit tests for the cross-platform clipboard module.
 *
 * Mocks `child_process` so the dispatch table can be asserted without
 * touching the real host clipboard. Each platform branch is exercised:
 *   - macOS  → pbpaste / pbcopy
 *   - Linux Wayland → wl-paste / wl-copy
 *   - Linux X11    → xclip -selection clipboard
 *   - Windows → PowerShell Get-Clipboard / Set-Clipboard
 *   - Linux without xclip / wl-clipboard → ClipboardUnavailableError
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.fn();
const spawnSyncMock = vi.fn();
const execSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
  execSync: (...args: unknown[]) => execSyncMock(...args),
}));

interface MockOsState {
  platform: NodeJS.Platform;
}

const osState: MockOsState = { platform: "linux" };

vi.mock("node:os", async () => {
  const real = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...real,
    platform: () => osState.platform,
    default: { ...real, platform: () => osState.platform },
  };
});

// Imported AFTER the mocks so they pick up the mocked dependencies.
const importClipboard = async () =>
  import("./clipboard.js").then((mod) => ({
    readClipboard: mod.readClipboard,
    writeClipboard: mod.writeClipboard,
    ClipboardUnavailableError: mod.ClipboardUnavailableError,
  }));

function setPlatform(p: NodeJS.Platform): void {
  osState.platform = p;
}

function setLinuxToolset(opts: { wayland: boolean; xclip: boolean }): void {
  // commandExists in helpers.ts uses execSync under the hood. Mock to honor
  // the per-tool availability requested by the test.
  execSyncMock.mockImplementation((cmd: string) => {
    const target = cmd.split(" ")[1] ?? "";
    if (target === "wl-paste" || target === "wl-copy") {
      if (opts.wayland) return "/usr/bin/" + target;
      throw new Error("not found");
    }
    if (target === "xclip") {
      if (opts.xclip) return "/usr/bin/xclip";
      throw new Error("not found");
    }
    throw new Error("not found");
  });
}

beforeEach(async () => {
  execFileSyncMock.mockReset();
  spawnSyncMock.mockReset();
  execSyncMock.mockReset();
  vi.resetModules();
  delete process.env.WAYLAND_DISPLAY;
  setPlatform("linux");
});

afterEach(() => {
  vi.unstubAllEnvs?.();
});

describe("clipboard — macOS", () => {
  it("read uses pbpaste", async () => {
    setPlatform("darwin");
    execFileSyncMock.mockReturnValue("hello mac");
    const { readClipboard } = await importClipboard();
    const text = await readClipboard();
    expect(text).toBe("hello mac");
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileSyncMock.mock.calls[0] ?? [];
    expect(cmd).toBe("pbpaste");
    expect(args).toEqual([]);
  });

  it("write uses pbcopy with stdin", async () => {
    setPlatform("darwin");
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" });
    const { writeClipboard } = await importClipboard();
    await writeClipboard("payload mac");
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = spawnSyncMock.mock.calls[0] ?? [];
    expect(cmd).toBe("pbcopy");
    expect(args).toEqual([]);
    expect((options as { input: string }).input).toBe("payload mac");
  });
});

describe("clipboard — Linux Wayland", () => {
  it("read uses wl-paste --no-newline when WAYLAND_DISPLAY is set", async () => {
    setPlatform("linux");
    process.env.WAYLAND_DISPLAY = "wayland-0";
    setLinuxToolset({ wayland: true, xclip: false });
    execFileSyncMock.mockReturnValue("wayland clip");
    const { readClipboard } = await importClipboard();
    const text = await readClipboard();
    expect(text).toBe("wayland clip");
    const [cmd, args] = execFileSyncMock.mock.calls[0] ?? [];
    expect(cmd).toBe("wl-paste");
    expect(args).toEqual(["--no-newline"]);
  });

  it("write uses wl-copy with stdin", async () => {
    setPlatform("linux");
    process.env.WAYLAND_DISPLAY = "wayland-0";
    setLinuxToolset({ wayland: true, xclip: false });
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" });
    const { writeClipboard } = await importClipboard();
    await writeClipboard("hello wayland");
    const [cmd, args, options] = spawnSyncMock.mock.calls[0] ?? [];
    expect(cmd).toBe("wl-copy");
    expect(args).toEqual([]);
    expect((options as { input: string }).input).toBe("hello wayland");
  });

  it("throws ClipboardUnavailableError when wl-clipboard is missing", async () => {
    setPlatform("linux");
    process.env.WAYLAND_DISPLAY = "wayland-0";
    setLinuxToolset({ wayland: false, xclip: false });
    const { readClipboard, ClipboardUnavailableError } = await importClipboard();
    await expect(readClipboard()).rejects.toBeInstanceOf(
      ClipboardUnavailableError,
    );
  });
});

describe("clipboard — Linux X11", () => {
  it("read uses xclip -selection clipboard -o when not on Wayland", async () => {
    setPlatform("linux");
    delete process.env.WAYLAND_DISPLAY;
    setLinuxToolset({ wayland: false, xclip: true });
    execFileSyncMock.mockReturnValue("x11 clip");
    const { readClipboard } = await importClipboard();
    const text = await readClipboard();
    expect(text).toBe("x11 clip");
    const [cmd, args] = execFileSyncMock.mock.calls[0] ?? [];
    expect(cmd).toBe("xclip");
    expect(args).toEqual(["-selection", "clipboard", "-o"]);
  });

  it("write pipes to xclip -selection clipboard -i", async () => {
    setPlatform("linux");
    delete process.env.WAYLAND_DISPLAY;
    setLinuxToolset({ wayland: false, xclip: true });
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" });
    const { writeClipboard } = await importClipboard();
    await writeClipboard("hello x11");
    const [cmd, args, options] = spawnSyncMock.mock.calls[0] ?? [];
    expect(cmd).toBe("xclip");
    expect(args).toEqual(["-selection", "clipboard", "-i"]);
    expect((options as { input: string }).input).toBe("hello x11");
  });

  it("throws ClipboardUnavailableError when xclip is missing", async () => {
    setPlatform("linux");
    delete process.env.WAYLAND_DISPLAY;
    setLinuxToolset({ wayland: false, xclip: false });
    const { writeClipboard, ClipboardUnavailableError } = await importClipboard();
    await expect(writeClipboard("foo")).rejects.toBeInstanceOf(
      ClipboardUnavailableError,
    );
  });
});

describe("clipboard — Windows", () => {
  it("read uses PowerShell Get-Clipboard -Raw", async () => {
    setPlatform("win32");
    execFileSyncMock.mockReturnValue("win clip\r\n");
    const { readClipboard } = await importClipboard();
    const text = await readClipboard();
    expect(text).toBe("win clip\r\n");
    const [cmd, args] = execFileSyncMock.mock.calls[0] ?? [];
    expect(cmd).toBe("powershell");
    expect(args).toEqual(["-NoProfile", "-Command", "Get-Clipboard -Raw"]);
  });

  it("write pipes to PowerShell Set-Clipboard via $input", async () => {
    setPlatform("win32");
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" });
    const { writeClipboard } = await importClipboard();
    await writeClipboard("hello windows");
    const [cmd, args, options] = spawnSyncMock.mock.calls[0] ?? [];
    expect(cmd).toBe("powershell");
    expect(args).toEqual(["-NoProfile", "-Command", "$input | Set-Clipboard"]);
    expect((options as { input: string }).input).toBe("hello windows");
  });
});

describe("clipboard — write error propagation", () => {
  it("rejects when the underlying tool exits non-zero", async () => {
    setPlatform("darwin");
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "pbcopy: boom",
    });
    const { writeClipboard } = await importClipboard();
    await expect(writeClipboard("oops")).rejects.toThrow(/pbcopy: boom/);
  });

  it("rejects on payloads beyond the 10MiB cap", async () => {
    setPlatform("darwin");
    const { writeClipboard } = await importClipboard();
    const tooBig = "a".repeat(10 * 1024 * 1024 + 1);
    await expect(writeClipboard(tooBig)).rejects.toBeInstanceOf(RangeError);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});
