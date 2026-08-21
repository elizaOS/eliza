/**
 * Unit coverage for Signal plugin `init()` when optional `SIGNAL_CLI_PATH` is
 * missing. `IAgentRuntime.getSetting()` returns `null` for unset keys; init
 * must default to `signal-cli` instead of throwing on `.trim()`. Fake runtime
 * only — no live signal-cli or network.
 */
import { type IAgentRuntime, logger, type UUID } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import signalPlugin from "./index.ts";
import { DEFAULT_SIGNAL_CLI_PATH } from "./service.ts";

function createRuntime(
  settings: Record<string, string | boolean | number | null> = {}
): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-000000000001" as UUID,
    getSetting: (key: string) => (Object.hasOwn(settings, key) ? settings[key] : null),
    getService: () => null,
  } as unknown as IAgentRuntime;
}

describe("signalPlugin.init SIGNAL_CLI_PATH defaulting", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exposes an init hook", () => {
    expect(signalPlugin.init).toEqual(expect.any(Function));
  });

  it("does not throw when SIGNAL_ACCOUNT_NUMBER is set and SIGNAL_CLI_PATH is unset", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);

    await expect(
      signalPlugin.init?.({}, createRuntime({ SIGNAL_ACCOUNT_NUMBER: "+15551234567" }))
    ).resolves.toBeUndefined();

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "local-cli",
        cliPath: DEFAULT_SIGNAL_CLI_PATH,
      }),
      "Signal plugin configuration validated successfully"
    );
  });

  it("does not throw when both SIGNAL_ACCOUNT_NUMBER and SIGNAL_CLI_PATH are unset", async () => {
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    await expect(signalPlugin.init?.({}, createRuntime())).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ src: "plugin:signal" }),
      "SIGNAL_ACCOUNT_NUMBER not provided - Signal plugin is loaded but will not be functional"
    );
  });

  it.each([true, 1] as const)(
    "defaults SIGNAL_CLI_PATH when getSetting returns non-string %p",
    async (value) => {
      const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);

      await expect(
        signalPlugin.init?.(
          {},
          createRuntime({
            SIGNAL_ACCOUNT_NUMBER: "+15551234567",
            SIGNAL_CLI_PATH: value,
          })
        )
      ).resolves.toBeUndefined();

      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          cliPath: DEFAULT_SIGNAL_CLI_PATH,
        }),
        "Signal plugin configuration validated successfully"
      );
    }
  );

  it.each(["", "   "] as const)(
    "defaults blank SIGNAL_CLI_PATH %p to signal-cli",
    async (value) => {
      const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);

      await expect(
        signalPlugin.init?.(
          {},
          createRuntime({
            SIGNAL_ACCOUNT_NUMBER: "+15551234567",
            SIGNAL_CLI_PATH: value,
          })
        )
      ).resolves.toBeUndefined();

      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          cliPath: DEFAULT_SIGNAL_CLI_PATH,
        }),
        "Signal plugin configuration validated successfully"
      );
    }
  );

  it("honors an explicit trimmed SIGNAL_CLI_PATH", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);

    await expect(
      signalPlugin.init?.(
        {},
        createRuntime({
          SIGNAL_ACCOUNT_NUMBER: "+15551234567",
          SIGNAL_CLI_PATH: " /opt/signal-cli ",
        })
      )
    ).resolves.toBeUndefined();

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        cliPath: "/opt/signal-cli",
      }),
      "Signal plugin configuration validated successfully"
    );
  });
});
