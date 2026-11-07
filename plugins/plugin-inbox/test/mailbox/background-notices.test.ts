import { describe, expect, it, vi } from "vitest";
import {
  createMailBackground,
  type MailBackgroundNative,
  mailBackgroundMessage,
  readMailNoticeTap,
} from "../../src/mailbox/background-notices.ts";

function bridge(overrides: Partial<MailBackgroundNative> = {}) {
  const calls: Array<[string, unknown]> = [];
  const native: MailBackgroundNative = {
    configure: async (input) => {
      calls.push(["configure", input]);
      return { status: "waiting" };
    },
    withdraw: async (input) => {
      calls.push(["withdraw", input]);
    },
    status: async () => ({ status: "watching-new-mail", lastSyncAt: 1 }),
    pending: async () => ({}),
    releaseQuestion: async (input) => {
      calls.push(["release", input]);
    },
    consume: async (input) => {
      calls.push(["consume", input]);
    },
    notificationSettings: async () => {
      calls.push(["settings", null]);
    },
    addListener: async () => ({ remove: async () => {} }),
    ...overrides,
  };
  return { native, calls };
}

const selection = {
  credentialId: "credential",
  grantId: "grant",
  userId: "user",
  organizationId: "org",
};

describe("background new-mail bridge", () => {
  it("is a safe no-op without the native module", async () => {
    const native = vi.fn();
    const background = createMailBackground({ native, available: false });
    await background.configure(selection);
    await background.withdraw("grant");
    await background.consume("token");
    expect(await background.status()).toEqual({ status: "web-unavailable" });
    expect(await background.pending()).toBeNull();
    await (await background.onNotice(() => {})).remove();
    expect(native).not.toHaveBeenCalled();
  });

  it("configures the named owner and grant, withdraws without a grant, and announces both", async () => {
    const { native, calls } = bridge();
    const changed = vi.fn();
    const background = createMailBackground({
      native: () => native,
      available: true,
      changed,
    });
    await background.configure(selection);
    await background.configure(null);
    expect(calls).toEqual([
      ["configure", selection],
      ["withdraw", undefined],
    ]);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("announces a change even when native configuration fails", async () => {
    const { native } = bridge({
      configure: async () => {
        throw new Error("Select Gmail on the unlocked phone");
      },
    });
    const changed = vi.fn();
    const background = createMailBackground({
      native: () => native,
      available: true,
      changed,
    });
    await expect(background.configure(selection)).rejects.toThrow();
    expect(changed).toHaveBeenCalledOnce();
  });

  it("retires a grant immediately and retries once after the revoke, never rejecting", async () => {
    let attempts = 0;
    const { native } = bridge({
      withdraw: async () => {
        attempts++;
        throw new Error("bridge closed");
      },
    });
    const background = createMailBackground({
      native: () => native,
      available: true,
    });
    const retirement = background.retire("grant");
    expect(attempts).toBe(1);
    await expect(retirement.settled()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it("reports an unreadable native status as unavailable", async () => {
    const { native } = bridge({
      status: async () => {
        throw new Error("locked");
      },
    });
    const background = createMailBackground({
      native: () => native,
      available: true,
    });
    expect(await background.status()).toEqual({ status: "unavailable" });
  });

  it("returns a tap only with every identity field", async () => {
    const tap = {
      token: "t",
      grantId: "g",
      credentialId: "c",
      userId: "u",
      generation: "n",
      question: true,
      messageId: "m",
      threadId: "th",
    };
    expect(readMailNoticeTap(tap)).toEqual(tap);
    expect(readMailNoticeTap({ ...tap, userId: "" })).toBeNull();
    expect(readMailNoticeTap({ token: "t" })).toBeNull();
    const { native } = bridge({ pending: async () => tap });
    const background = createMailBackground({
      native: () => native,
      available: true,
    });
    expect(await background.pending()).toEqual(tap);
  });

  it("never surfaces a missing listener bridge as a rejection", async () => {
    const { native } = bridge({
      addListener: () => Promise.reject(new Error("not implemented")),
    });
    const background = createMailBackground({
      native: () => native,
      available: true,
    });
    const listener = await background.onNotice(() => {});
    await expect(listener.remove()).resolves.toBeUndefined();
    const throwing = createMailBackground({
      native: () => {
        throw new Error("missing");
      },
      available: true,
    });
    await expect(
      (await throwing.onNotice(() => {})).remove(),
    ).resolves.toBeUndefined();
  });
});

describe("background status text", () => {
  it("never mentions an inference provider and names the delay caveat", () => {
    for (const status of [
      "disabled",
      "unsupported",
      "grant-unavailable",
      "capacity-reached",
      "retrying",
      "watching-new-mail",
    ])
      expect(mailBackgroundMessage({ status })).not.toMatch(/provider/i);
    expect(mailBackgroundMessage({ status: "watching-new-mail" })).toMatch(
      /No successful background check yet\..*Doze/,
    );
  });

  it("states uncertainty, denial and expired history truthfully", () => {
    expect(
      mailBackgroundMessage({
        status: "catching-up",
        uncertainNotices: 2,
        notificationsAllowed: false,
      }),
    ).toMatch(
      /still being reconciled\. Android notifications or this channel are disabled\. Some notification attempts have unknown outcomes/,
    );
    expect(mailBackgroundMessage({ status: "history-expired" })).toMatch(
      /Earlier missed messages were not reconciled/,
    );
    expect(mailBackgroundMessage({ status: "web-unavailable" })).toBe(
      "Background Gmail notices are available in the Android app.",
    );
  });
});
