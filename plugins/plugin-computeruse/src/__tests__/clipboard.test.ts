import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeClipboardCommands } from "../platform/clipboard.js";
import { ComputerUseService } from "../services/computer-use-service.js";

vi.mock("../platform/clipboard.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../platform/clipboard.js")>();
  return {
    ...actual,
    getClipboardText: vi.fn(async () => "clipboard text"),
    setClipboardText: vi.fn(async () => undefined),
  };
});

function createMockRuntime(): IAgentRuntime {
  return {
    character: {},
    getSetting(key: string) {
      return key === "COMPUTER_USE_APPROVAL_MODE" ? "full_control" : undefined;
    },
    getService() {
      return null;
    },
  } as IAgentRuntime;
}

describe("clipboard platform helpers", () => {
  it("uses pbcopy/pbpaste on macOS", () => {
    expect(
      describeClipboardCommands({
        osName: "darwin",
        commandExists: () => false,
      }),
    ).toEqual({
      get: { command: "pbpaste", args: [] },
      set: { command: "pbcopy", args: [] },
    });
  });

  it("prefers wl-clipboard on Linux", () => {
    const commands = describeClipboardCommands({
      osName: "linux",
      commandExists: (command) => command === "wl-copy" || command === "wl-paste",
    });

    expect(commands.get.command).toBe("wl-paste");
    expect(commands.set.command).toBe("wl-copy");
  });

  it("falls back to xclip then xsel on Linux", () => {
    expect(
      describeClipboardCommands({
        osName: "linux",
        commandExists: (command) => command === "xclip",
      }),
    ).toMatchObject({
      get: { command: "xclip" },
      set: { command: "xclip" },
    });

    expect(
      describeClipboardCommands({
        osName: "linux",
        commandExists: (command) => command === "xsel",
      }),
    ).toMatchObject({
      get: { command: "xsel" },
      set: { command: "xsel" },
    });
  });

  it("uses PowerShell on Windows", () => {
    const commands = describeClipboardCommands({
      osName: "win32",
      commandExists: () => false,
    });

    expect(commands.get.command).toBe("powershell.exe");
    expect(commands.set.command).toBe("powershell.exe");
  });
});

describe("ComputerUseService clipboard commands", () => {
  let service: ComputerUseService | null = null;

  afterEach(async () => {
    if (service) {
      await service.stop();
      service = null;
    }
    vi.clearAllMocks();
  });

  it("exposes clipboard_get and get_clipboard aliases", async () => {
    service = (await ComputerUseService.start(
      createMockRuntime(),
    )) as ComputerUseService;

    await expect(service.executeCommand("clipboard_get")).resolves.toMatchObject({
      success: true,
      text: "clipboard text",
      content: "clipboard text",
      value: "clipboard text",
    });
    await expect(service.executeCommand("get_clipboard")).resolves.toMatchObject({
      success: true,
      text: "clipboard text",
    });
  });

  it("exposes copy_to_clipboard, set_clipboard, and clipboard_set aliases", async () => {
    const { setClipboardText } = await import("../platform/clipboard.js");
    service = (await ComputerUseService.start(
      createMockRuntime(),
    )) as ComputerUseService;

    await expect(
      service.executeCommand("copy_to_clipboard", { text: "from text" }),
    ).resolves.toMatchObject({ success: true });
    await expect(
      service.executeCommand("set_clipboard", { content: "from content" }),
    ).resolves.toMatchObject({ success: true });
    await expect(
      service.executeCommand("clipboard_set", { value: "from value" }),
    ).resolves.toMatchObject({ success: true });

    expect(setClipboardText).toHaveBeenNthCalledWith(1, "from text");
    expect(setClipboardText).toHaveBeenNthCalledWith(2, "from content");
    expect(setClipboardText).toHaveBeenNthCalledWith(3, "from value");
  });
});
