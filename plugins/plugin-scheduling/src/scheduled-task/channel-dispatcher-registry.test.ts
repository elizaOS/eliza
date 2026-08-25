import { ElizaError } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  getScheduledTaskChannelDispatcher,
  listScheduledTaskChannelDispatcherKeys,
  registerScheduledTaskChannelDispatcher,
  unregisterScheduledTaskChannelDispatcher,
} from "./channel-dispatcher-registry.ts";

function makeContribution(channelKey: string) {
  return { channelKey, dispatch: vi.fn(async () => undefined) };
}

describe("registerScheduledTaskChannelDispatcher", () => {
  it("rejects a missing channelKey", () => {
    const runtime = {};
    expect(() =>
      registerScheduledTaskChannelDispatcher(runtime as never, {
        channelKey: "",
        dispatch: async () => undefined,
      }),
    ).toThrow("channelKey required");
  });

  it("rejects a non-string channelKey", () => {
    const runtime = {};
    expect(() =>
      registerScheduledTaskChannelDispatcher(
        runtime as never,
        { channelKey: 42, dispatch: async () => undefined } as never,
      ),
    ).toThrow("channelKey required");
  });

  it("rejects a contribution without a dispatch function", () => {
    const runtime = {};
    expect(() =>
      registerScheduledTaskChannelDispatcher(
        runtime as never,
        { channelKey: "my_channel" } as never,
      ),
    ).toThrow('dispatch function required for channel "my_channel"');
  });

  it("rejects a reserved built-in channel key to prevent silent hijack", () => {
    const runtime = {};
    expect(() =>
      registerScheduledTaskChannelDispatcher(
        runtime as never,
        makeContribution("coding_agent_pr_shepherd"),
      ),
    ).toThrow(ElizaError);
    try {
      registerScheduledTaskChannelDispatcher(
        runtime as never,
        makeContribution("coding_agent_pr_shepherd"),
      );
    } catch (error) {
      const e = error as ElizaError;
      expect(e.code).toBe("SCHEDULED_TASK_CHANNEL_KEY_RESERVED");
      expect(e.context).toEqual({ channelKey: "coding_agent_pr_shepherd" });
    }
  });

  it("rejects every literal reserved host channel key", () => {
    const runtime = {};
    for (const key of [
      "in_app",
      "push",
      "browser",
      "email",
      "imessage",
      "telegram",
      "discord",
      "whatsapp",
      "x",
      "x_dm",
      "sms",
      "voice",
      "twilio_voice",
    ]) {
      expect(() =>
        registerScheduledTaskChannelDispatcher(
          runtime as never,
          makeContribution(key),
        ),
      ).toThrow(`channel key "${key}" is reserved`);
    }
  });

  it("rejects a duplicate channel key on the same runtime", () => {
    const runtime = {};
    registerScheduledTaskChannelDispatcher(
      runtime as never,
      makeContribution("wallet_balance_delta"),
    );
    expect(() =>
      registerScheduledTaskChannelDispatcher(
        runtime as never,
        makeContribution("wallet_balance_delta"),
      ),
    ).toThrow('duplicate channel "wallet_balance_delta"');
  });

  it("allows the same channel key on a different runtime", () => {
    registerScheduledTaskChannelDispatcher(
      {} as never,
      makeContribution("shared_channel"),
    );
    expect(() =>
      registerScheduledTaskChannelDispatcher(
        {} as never,
        makeContribution("shared_channel"),
      ),
    ).not.toThrow();
  });
});

describe("getScheduledTaskChannelDispatcher", () => {
  it("returns null for an unknown key", () => {
    expect(getScheduledTaskChannelDispatcher({} as never, "nope")).toBeNull();
  });

  it("returns the registered contribution for a known key", () => {
    const runtime = {};
    const contribution = makeContribution("my_channel");
    registerScheduledTaskChannelDispatcher(runtime as never, contribution);
    expect(
      getScheduledTaskChannelDispatcher(runtime as never, "my_channel"),
    ).toBe(contribution);
  });
});

describe("listScheduledTaskChannelDispatcherKeys", () => {
  it("lists registered keys in registration order", () => {
    const runtime = {};
    registerScheduledTaskChannelDispatcher(
      runtime as never,
      makeContribution("a_channel"),
    );
    registerScheduledTaskChannelDispatcher(
      runtime as never,
      makeContribution("b_channel"),
    );
    expect(listScheduledTaskChannelDispatcherKeys(runtime as never)).toEqual([
      "a_channel",
      "b_channel",
    ]);
  });

  it("returns [] for a runtime with no contributions", () => {
    expect(listScheduledTaskChannelDispatcherKeys({} as never)).toEqual([]);
  });
});

describe("unregisterScheduledTaskChannelDispatcher", () => {
  it("returns false for an unknown key", () => {
    expect(
      unregisterScheduledTaskChannelDispatcher({} as never, "missing"),
    ).toBe(false);
  });

  it("refuses to remove when the identity guard does not match", () => {
    const runtime = {};
    const registered = makeContribution("my_channel");
    registerScheduledTaskChannelDispatcher(runtime as never, registered);
    const impostor = makeContribution("my_channel");
    expect(
      unregisterScheduledTaskChannelDispatcher(
        runtime as never,
        "my_channel",
        impostor,
      ),
    ).toBe(false);
    expect(
      getScheduledTaskChannelDispatcher(runtime as never, "my_channel"),
    ).toBe(registered);
  });

  it("removes the contribution when the identity matches", () => {
    const runtime = {};
    const contribution = makeContribution("my_channel");
    registerScheduledTaskChannelDispatcher(runtime as never, contribution);
    expect(
      unregisterScheduledTaskChannelDispatcher(
        runtime as never,
        "my_channel",
        contribution,
      ),
    ).toBe(true);
    expect(
      getScheduledTaskChannelDispatcher(runtime as never, "my_channel"),
    ).toBeNull();
  });
});
