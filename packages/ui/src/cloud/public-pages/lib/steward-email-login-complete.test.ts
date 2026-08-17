/** Verifies the token-free cross-tab Steward email-login completion signal. */
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isStewardEmailLoginCompleteMessage,
  publishStewardEmailLoginComplete,
  STEWARD_EMAIL_LOGIN_COMPLETE_CHANNEL,
  STEWARD_EMAIL_LOGIN_COMPLETE_MESSAGE_TYPE,
  subscribeStewardEmailLoginComplete,
} from "./steward-email-login-complete";

class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];

  readonly name: string;
  readonly postMessage = vi.fn();
  readonly close = vi.fn();
  readonly addEventListener = vi.fn();
  readonly removeEventListener = vi.fn();

  constructor(name: string) {
    this.name = name;
    FakeBroadcastChannel.instances.push(this);
  }
}

afterEach(() => {
  FakeBroadcastChannel.instances = [];
  vi.unstubAllGlobals();
});

describe("Steward email login completion signal", () => {
  it("publishes only normalized email and destination, never session tokens", () => {
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);

    publishStewardEmailLoginComplete(" Person@Example.COM ", "/cloud");

    const channel = FakeBroadcastChannel.instances[0];
    expect(channel.name).toBe(STEWARD_EMAIL_LOGIN_COMPLETE_CHANNEL);
    expect(channel.postMessage).toHaveBeenCalledWith({
      type: STEWARD_EMAIL_LOGIN_COMPLETE_MESSAGE_TYPE,
      email: "person@example.com",
      destination: "/cloud",
    });
    expect(channel.close).toHaveBeenCalledOnce();
  });

  it("delivers only valid messages for the waiting email and unsubscribes", () => {
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    const onComplete = vi.fn();

    const unsubscribe = subscribeStewardEmailLoginComplete(
      "person@example.com",
      onComplete,
    );
    const channel = FakeBroadcastChannel.instances[0];
    const handler = channel.addEventListener.mock.calls[0][1] as (
      event: MessageEvent,
    ) => void;

    handler(
      new MessageEvent("message", {
        data: {
          type: STEWARD_EMAIL_LOGIN_COMPLETE_MESSAGE_TYPE,
          email: "someone-else@example.com",
          destination: "/cloud",
        },
      }),
    );
    expect(onComplete).not.toHaveBeenCalled();

    const matching = {
      type: STEWARD_EMAIL_LOGIN_COMPLETE_MESSAGE_TYPE,
      email: "PERSON@example.com",
      destination: "/get-started",
    };
    expect(
      isStewardEmailLoginCompleteMessage(matching, "person@example.com"),
    ).toBe(true);
    handler(new MessageEvent("message", { data: matching }));
    expect(onComplete).toHaveBeenCalledWith(matching);

    unsubscribe();
    expect(channel.removeEventListener).toHaveBeenCalledWith(
      "message",
      handler,
    );
    expect(channel.close).toHaveBeenCalledOnce();
  });

  it("rejects external destinations even when the email matches", () => {
    for (const destination of [
      "https://attacker.example",
      "//attacker.example",
      "/\\\\evil.example",
    ]) {
      expect(
        isStewardEmailLoginCompleteMessage(
          {
            type: STEWARD_EMAIL_LOGIN_COMPLETE_MESSAGE_TYPE,
            email: "person@example.com",
            destination,
          },
          "person@example.com",
        ),
      ).toBe(false);
    }
  });
});
