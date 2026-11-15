import type { NativeCloudSignInPort } from "@elizaos/auth/auth/native-cloud-sign-in";
import { describe, expect, it, vi } from "vitest";
import { NativeCloudSignInController } from "../native-cloud-sign-in-controller";

const oldAttempt = "6f1c2c63-6d7a-4bd6-9b6c-1f2d3e4a5b6c";
const newAttempt = "ac8d3bb8-e364-48bf-b720-b32d493094d1";
const credentialId = "f7326b60-6eaf-442c-be8d-91ae12d07423";
const email = "owner@example.invalid";

function startReceipt(attemptId: string) {
  return { attemptId, expiresAt: Date.now() + 60_000, resendAt: Date.now() };
}

function nativeFixture(admission: "rejected" | "admitted") {
  let active: { requestId: string; attemptId: string } | null = null;
  const requests: string[] = [];
  const activate = vi.fn();
  const abandoned = vi.fn();
  const port = {
    async startGoogle() {
      throw new Error("Unexpected method");
    },
    startEmail: vi.fn(async ({ requestId }) => {
      if (!requestId) throw new Error("Expected a scoped dispatch");
      requests.push(requestId);
      if (!active) {
        active = { requestId, attemptId: oldAttempt };
        return startReceipt(oldAttempt);
      }
      if (admission === "rejected") throw { code: "cooldown" };
      active = { requestId, attemptId: newAttempt };
      throw new Error("Lost the bridge reply after native admission");
    }),
    verifyEmail: vi.fn(async ({ attemptId }) => {
      if (!active || attemptId !== active.attemptId) throw { code: "expired" };
      const { requestId } = active;
      active = null;
      return {
        status: "authenticated",
        environment: "production",
        expiresAt: Date.now() + 60_000,
        accountCreated: false,
        requestId,
        attemptId,
        credentialId,
      };
    }),
    async verifyMfa() {
      throw new Error("Unexpected factor");
    },
    cancel: vi.fn(async (input) => {
      if (!input) throw new Error("Expected scoped cancellation");
      if (input.requestId === active?.requestId) active = null;
    }),
  } satisfies NativeCloudSignInPort<"production">;
  const controller = new NativeCloudSignInController(port, {
    environment: "production",
    current: () => true,
    activate,
    abandoned,
  });
  return {
    controller,
    port,
    activate,
    abandoned,
    requests,
    activeRequest: () => active?.requestId,
    admitResend: (requestId: string) => {
      requests.push(requestId);
      active = { requestId, attemptId: newAttempt };
    },
  };
}

describe("native sign-in resend ownership", () => {
  it("accepts verification for the displayed code after a rejected resend", async () => {
    const f = nativeFixture("rejected");
    await f.controller.startEmail(email);
    await f.controller.resend();
    expect(f.controller.getSnapshot().error?.code).toBe("cooldown");
    expect(f.controller.getSnapshot().step).toMatchObject({
      kind: "code",
      attemptId: oldAttempt,
    });
    await f.controller.verify("123456");
    expect(f.port.verifyEmail).toHaveBeenCalledWith({
      attemptId: oldAttempt,
      code: "123456",
    });
    expect(f.activate).toHaveBeenCalledOnce();
    expect(f.activate).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: f.requests[0],
        attemptId: oldAttempt,
        credentialId,
      }),
      expect.any(AbortSignal),
    );
    expect(f.controller.getSnapshot().stage).toBe("complete");
  });

  it("correlates a retained verification to the admitted displayed attempt", async () => {
    const f = nativeFixture("rejected");
    await f.controller.startEmail(email);
    await f.controller.resend();
    const [original, resend] = f.requests;
    f.port.verifyEmail.mockImplementationOnce(() => new Promise(() => {}));
    const verification = f.controller.verify("123456");
    const outcome = {
      status: "authenticated",
      environment: "production",
      expiresAt: Date.now() + 60_000,
      accountCreated: false,
      attemptId: oldAttempt,
      credentialId,
    };
    await f.controller.acceptReturn({ ...outcome, requestId: resend });
    expect(f.activate).not.toHaveBeenCalled();
    await f.controller.acceptReturn({ ...outcome, requestId: original });
    await verification;
    expect(f.activate).toHaveBeenCalledOnce();
    expect(f.controller.getSnapshot().stage).toBe("complete");
  });

  it.each(["rejected", "admitted"] as const)(
    "retires both candidates when the resend is %s and leaves no usable code",
    async (admission) => {
      const f = nativeFixture(admission);
      await f.controller.startEmail(email);
      await f.controller.resend();
      expect(f.activeRequest()).toBe(
        f.requests[admission === "admitted" ? 1 : 0],
      );
      await f.controller.leave();
      expect(f.port.cancel.mock.calls).toEqual(
        f.requests.map((requestId) => [{ requestId }]),
      );
      expect(f.activeRequest()).toBeUndefined();
      expect(f.abandoned).toHaveBeenCalledOnce();
    },
  );

  it("retires both candidates before a held resend reply can publish", async () => {
    const f = nativeFixture("admitted");
    let settle!: (value: ReturnType<typeof startReceipt>) => void;
    await f.controller.startEmail(email);
    f.port.startEmail.mockImplementationOnce(({ requestId }) => {
      if (!requestId) throw new Error("Expected a scoped dispatch");
      f.admitResend(requestId);
      return new Promise((resolve) => {
        settle = resolve;
      });
    });
    const resend = f.controller.resend();
    await f.controller.chooseAnotherMethod();
    await resend;
    settle(startReceipt(newAttempt));
    await Promise.resolve();
    expect(f.port.cancel.mock.calls).toEqual(
      f.requests.map((requestId) => [{ requestId }]),
    );
    expect(f.activeRequest()).toBeUndefined();
    expect(f.controller.getSnapshot().step.kind).toBe("methods");
  });

  it("retries only the unacknowledged scope and holds the owner until it settles", async () => {
    const f = nativeFixture("rejected");
    await f.controller.startEmail(email);
    await f.controller.resend();
    const [original, resend] = f.requests;
    const nativeCancel = f.port.cancel.getMockImplementation();
    if (!nativeCancel) throw new Error("Missing native cancellation port");
    f.port.cancel.mockImplementation(async (input) => {
      if (input?.requestId === original) throw new Error("Bridge reply lost");
      await nativeCancel(input);
    });
    await f.controller.leave();
    expect(f.activeRequest()).toBe(original);
    expect(f.abandoned).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot().error?.code).toBe("unavailable");
    await f.controller.startEmail(email);
    expect(f.port.startEmail).toHaveBeenCalledTimes(2);
    f.port.cancel.mockImplementation(nativeCancel);
    await f.controller.leave();
    expect(f.port.cancel.mock.calls).toEqual([
      [{ requestId: original }],
      [{ requestId: resend }],
      [{ requestId: original }],
      [{ requestId: original }],
    ]);
    expect(f.activeRequest()).toBeUndefined();
    expect(f.abandoned).toHaveBeenCalledOnce();
  });
});
