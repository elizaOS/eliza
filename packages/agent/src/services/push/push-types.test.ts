/**
 * Covers the remote-push shared types: PushUnregisteredError construction,
 * Error inheritance, token/message fields, name, instanceof across throw and
 * rejection, and the PushProvider/PushMessage contract as exercised by a
 * real in-process provider. No mocks of the module under test.
 */
import { describe, expect, it } from "vitest";
import type { PushMessage, PushProvider } from "./push-types.ts";
import { PushUnregisteredError } from "./push-types.ts";

/**
 * In-process PushProvider that records deliveries and throws the real
 * PushUnregisteredError for tokens marked dead. Mirrors how
 * NotificationPushService branches on `instanceof PushUnregisteredError`.
 */
class InProcessProvider implements PushProvider {
  readonly sent: Array<{ token: string; message: PushMessage }> = [];

  constructor(
    readonly name: string,
    private configured: boolean,
    private readonly deadTokens: ReadonlySet<string> = new Set(),
  ) {}

  isConfigured(): boolean {
    return this.configured;
  }

  async send(token: string, message: PushMessage): Promise<void> {
    if (this.deadTokens.has(token)) {
      throw new PushUnregisteredError(
        token,
        `[${this.name}] token rejected (status=410 reason=Unregistered)`,
      );
    }
    this.sent.push({ token, message });
  }
}

/** Same branch NotificationPushService.dispatch uses for dead-token removal. */
async function classifySend(
  send: () => Promise<void>,
): Promise<"ok" | "dropped" | "failed"> {
  try {
    await send();
    return "ok";
  } catch (error) {
    if (error instanceof PushUnregisteredError) {
      return "dropped";
    }
    return "failed";
  }
}

describe("PushUnregisteredError", () => {
  it("stores the token and message from the constructor", () => {
    const error = new PushUnregisteredError(
      "device-token-1",
      "[ApnsProvider] token rejected (status=410 reason=Unregistered)",
    );
    expect(error.token).toBe("device-token-1");
    expect(error.message).toBe(
      "[ApnsProvider] token rejected (status=410 reason=Unregistered)",
    );
  });

  it("sets name to PushUnregisteredError", () => {
    const error = new PushUnregisteredError("tok", "dead");
    expect(error.name).toBe("PushUnregisteredError");
  });

  it("is an Error and a PushUnregisteredError", () => {
    const error = new PushUnregisteredError("tok", "dead");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(PushUnregisteredError);
  });

  it("is distinct from a generic Error with the same message", () => {
    const generic = new Error("dead");
    expect(generic).not.toBeInstanceOf(PushUnregisteredError);
    expect(generic.name).toBe("Error");
  });

  it("is distinct from a generic Error whose name was overwritten", () => {
    const spoofed = new Error("dead");
    spoofed.name = "PushUnregisteredError";
    expect(spoofed).not.toBeInstanceOf(PushUnregisteredError);
    expect(spoofed instanceof PushUnregisteredError).toBe(false);
  });

  it("survives throw/catch with token intact", () => {
    let caught: unknown;
    try {
      throw new PushUnregisteredError("ios-dead", "unregistered");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PushUnregisteredError);
    expect((caught as PushUnregisteredError).token).toBe("ios-dead");
    expect((caught as PushUnregisteredError).message).toBe("unregistered");
  });

  it("survives promise rejection with instanceof intact", async () => {
    const rejected = Promise.reject(
      new PushUnregisteredError("fcm-dead", "UNREGISTERED"),
    );
    await expect(rejected).rejects.toBeInstanceOf(PushUnregisteredError);
    await expect(rejected).rejects.toMatchObject({
      token: "fcm-dead",
      message: "UNREGISTERED",
      name: "PushUnregisteredError",
    });
  });

  it("stores an empty token and empty message as given", () => {
    const error = new PushUnregisteredError("", "");
    expect(error.token).toBe("");
    expect(error.message).toBe("");
    expect(error).toBeInstanceOf(PushUnregisteredError);
  });

  it("stores a unicode token as-is with no truncation", () => {
    const token = `tok-${"🎯".repeat(8)}-${"x".repeat(4096)}`;
    const error = new PushUnregisteredError(token, "dead");
    expect(error.token).toBe(token);
    expect(error.token.length).toBe(token.length);
  });

  it("keeps two errors with the same token as distinct instances", () => {
    const a = new PushUnregisteredError("shared", "first");
    const b = new PushUnregisteredError("shared", "second");
    expect(a).not.toBe(b);
    expect(a.token).toBe(b.token);
    expect(a.message).toBe("first");
    expect(b.message).toBe("second");
  });

  it("exposes token as an own property", () => {
    const error = new PushUnregisteredError("own-token", "dead");
    expect(Object.hasOwn(error, "token")).toBe(true);
    expect(error.token).toBe("own-token");
  });

  it("renders name and message through Error#toString", () => {
    const error = new PushUnregisteredError(
      "tok",
      "[FcmProvider] token rejected (status=404 code=UNREGISTERED)",
    );
    expect(error.toString()).toBe(
      "PushUnregisteredError: [FcmProvider] token rejected (status=404 code=UNREGISTERED)",
    );
  });

  it("captures a stack string", () => {
    const error = new PushUnregisteredError("tok", "dead");
    expect(typeof error.stack).toBe("string");
    expect(error.stack).toContain("PushUnregisteredError");
  });
});

describe("PushProvider and PushMessage", () => {
  it("reports unconfigured when credentials are absent", () => {
    const provider = new InProcessProvider("apns", false);
    expect(provider.name).toBe("apns");
    expect(provider.isConfigured()).toBe(false);
  });

  it("reports configured when credentials are present", () => {
    const provider = new InProcessProvider("fcm", true);
    expect(provider.isConfigured()).toBe(true);
  });

  it("delivers a title-only message to a live token", async () => {
    const provider = new InProcessProvider("apns", true);
    const message: PushMessage = { title: "Hello" };
    await provider.send("live-token", message);
    expect(provider.sent).toEqual([{ token: "live-token", message }]);
  });

  it("delivers body and nested JsonValue data without dropping keys", async () => {
    const provider = new InProcessProvider("fcm", true);
    const message: PushMessage = {
      title: "Task due",
      body: "Review the agenda",
      data: {
        notificationId: "n-1",
        category: "task",
        deepLink: "/tasks/n-1",
        count: 2,
        urgent: true,
        note: null,
        tags: ["work", "today"],
        extra: { nested: "ok" },
      },
    };
    await provider.send("android-1", message);
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].token).toBe("android-1");
    expect(provider.sent[0].message).toEqual(message);
    expect(provider.sent[0].message.data).toEqual({
      notificationId: "n-1",
      category: "task",
      deepLink: "/tasks/n-1",
      count: 2,
      urgent: true,
      note: null,
      tags: ["work", "today"],
      extra: { nested: "ok" },
    });
  });

  it("rejects a dead token with PushUnregisteredError carrying that token", async () => {
    const provider = new InProcessProvider(
      "apns",
      true,
      new Set(["dead-token"]),
    );
    await expect(provider.send("dead-token", { title: "Hi" })).rejects.toEqual(
      expect.objectContaining({
        name: "PushUnregisteredError",
        token: "dead-token",
        message: "[apns] token rejected (status=410 reason=Unregistered)",
      }),
    );
    await expect(
      provider.send("dead-token", { title: "Hi" }),
    ).rejects.toBeInstanceOf(PushUnregisteredError);
    expect(provider.sent).toEqual([]);
  });

  it("classifies an unregistered throw as dropped, not a generic failure", async () => {
    const provider = new InProcessProvider("fcm", true, new Set(["gone"]));
    expect(
      await classifySend(() => provider.send("gone", { title: "x" })),
    ).toBe("dropped");
    expect(
      await classifySend(() => provider.send("live", { title: "x" })),
    ).toBe("ok");
  });

  it("does not treat a generic send failure as unregistered", async () => {
    const outcome = await classifySend(async () => {
      throw new Error(
        "[ApnsProvider] APNs request failed (status=500 reason=n/a)",
      );
    });
    expect(outcome).toBe("failed");
  });

  it("does not treat a missing live token as unregistered", async () => {
    const provider = new InProcessProvider("apns", true, new Set(["dead"]));
    const message: PushMessage = { title: "ping" };
    expect(await classifySend(() => provider.send("other", message))).toBe(
      "ok",
    );
    expect(provider.sent).toEqual([{ token: "other", message }]);
  });

  it("keeps an empty send queue until the first live delivery", async () => {
    const provider = new InProcessProvider("apns", true, new Set(["dead"]));
    expect(provider.sent).toEqual([]);
    await expect(provider.send("dead", { title: "x" })).rejects.toBeInstanceOf(
      PushUnregisteredError,
    );
    expect(provider.sent).toEqual([]);
    await provider.send("live", { title: "x" });
    expect(provider.sent).toHaveLength(1);
  });
});
