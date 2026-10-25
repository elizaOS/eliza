// @vitest-environment node
import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IosAuthNotReadyError, SideloaderIosBackend } from "./ios-backend";
import { createIosHandler } from "./ios-handler";

const result = (stdout = "", exitCode = 0) => ({
  stdout,
  stderr: "",
  exitCode,
});
function fixture() {
  const command = vi.fn(async (cmd: string, args: string[]) => {
    if (cmd === "idevice_id") return result("device-1\n");
    if (cmd === "ideviceinfo")
      return result(
        "DeviceName: Fixture\nProductVersion: 17.0\nCPUArchitecture: arm64\n",
      );
    if (args[0] === "sign") {
      const output = args[args.indexOf("--output") + 1];
      if (!output) throw new Error("Missing fixture signing output");
      await writeFile(output, "signed fixture");
    }
    return result("success");
  });
  const backend = new SideloaderIosBackend(command);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("fixture ipa")),
  );
  return { backend, command };
}
afterEach(() => vi.unstubAllGlobals());
const input = {
  deviceUdid: "device-1",
  appId: "elizaos-main",
  appleId: "fixture@example.test",
};

describe("iOS installation attempt", () => {
  it("authenticates, plans, installs and consumes authentication", async () => {
    const { backend } = fixture();
    await backend.authenticate(input.appleId, "fixture");
    const plan = await backend.createInstallPlan(input);
    expect(plan.device.connectionType).toBe("usb");
    const progress = vi.fn();
    await backend.executeInstallPlan(plan, progress);
    expect(progress).toHaveBeenCalledWith("complete", "complete");
    await expect(backend.createInstallPlan(input)).rejects.toBeInstanceOf(
      IosAuthNotReadyError,
    );
  });
  it("does not confuse a failed command mentioning success with successful 2FA", async () => {
    const { backend, command } = fixture();
    command.mockResolvedValueOnce(result("2fa required", 1));
    expect((await backend.authenticate(input.appleId, "fixture")).status).toBe(
      "awaiting-2fa",
    );
    command.mockResolvedValueOnce(
      result("not authenticated; previous success expired", 1),
    );
    expect((await backend.submit2fa("123456")).status).toBe("failed");
  });
  it.each(["download", "sign", "install"])(
    "rejects %s failure instead of returning success",
    async (phase) => {
      const { backend, command } = fixture();
      await backend.authenticate(input.appleId, "fixture");
      const plan = await backend.createInstallPlan(input);
      if (phase === "download")
        vi.stubGlobal("fetch", async () => new Response("no", { status: 503 }));
      else {
        const original = command.getMockImplementation();
        if (!original)
          throw new Error("Missing fixture command implementation");
        command.mockImplementation(async (cmd, args) =>
          args[0] === phase ? result("failed", 1) : original(cmd, args),
        );
      }
      const progress = vi.fn();
      await expect(
        backend.executeInstallPlan(plan, progress),
      ).rejects.toThrow();
      expect(progress).not.toHaveBeenCalledWith("complete", "complete");
    },
  );
  it("propagates discovery failures and matches device identities exactly", async () => {
    const { backend, command } = fixture();
    command.mockResolvedValueOnce(result("", 1));
    await expect(backend.listDevices()).rejects.toThrow("Unable to list");
    await backend.authenticate(input.appleId, "fixture");
    const plan = await backend.createInstallPlan(input);
    command.mockResolvedValueOnce(result("other-device-1\n"));
    await expect(backend.executeInstallPlan(plan, vi.fn())).rejects.toThrow(
      "no longer connected",
    );
  });
  it("binds authentication and the immutable server plan to a single-use token", async () => {
    const { backend } = fixture();
    const handler = createIosHandler(backend, {});
    const post = (route: string, body: object) =>
      handler(
        new Request(`http://localhost/ios/${route}`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
        `/ios/${route}`,
      );
    const auth = await (
      await post("authenticate", {
        appleId: input.appleId,
        password: "fixture",
      })
    ).json();
    const attemptToken = auth.attemptToken;
    expect(typeof attemptToken).toBe("string");
    expect(
      (await post("authenticate", { appleId: "other", password: "fixture" }))
        .status,
    ).toBe(409);
    expect((await post("plan", { ...input, attemptToken })).status).toBe(200);
    expect(
      (
        await post("execute", {
          attemptToken,
          plan: { app: { ipaUrl: "https://invalid.example" } },
        })
      ).status,
    ).toBe(400);
    const execution = await post("execute", { attemptToken });
    expect(await execution.text()).toContain('"done":true');
    expect((await post("execute", { attemptToken })).status).toBe(409);
  });
  it.each(["invalid-input", "backend-failure"])(
    "invalidates the prior plan when replacement fails: %s",
    async (failure) => {
      const { backend } = fixture();
      const execute = vi.spyOn(backend, "executeInstallPlan");
      const handler = createIosHandler(backend, {});
      const post = (route: string, body: object) =>
        handler(
          new Request(`http://localhost/ios/${route}`, {
            method: "POST",
            body: JSON.stringify(body),
          }),
          `/ios/${route}`,
        );
      const { attemptToken } = await (
        await post("authenticate", {
          appleId: input.appleId,
          password: "fixture",
        })
      ).json();
      expect((await post("plan", { ...input, attemptToken })).status).toBe(200);
      if (failure === "backend-failure")
        vi.spyOn(backend, "createInstallPlan").mockRejectedValueOnce(
          new Error("unavailable"),
        );
      expect(
        (
          await post(
            "plan",
            failure === "invalid-input"
              ? { attemptToken }
              : { ...input, attemptToken },
          )
        ).status,
      ).toBe(400);
      expect((await post("execute", { attemptToken })).status).toBe(400);
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it("never emits done after a backend emits failure and returns", async () => {
    const { backend } = fixture();
    vi.spyOn(backend, "executeInstallPlan").mockImplementation(
      async (_plan, progress) => {
        progress("install-ipa", "failed");
      },
    );
    const handler = createIosHandler(backend, {});
    const post = (route: string, body: object) =>
      handler(
        new Request(`http://localhost/ios/${route}`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
        `/ios/${route}`,
      );
    const { attemptToken } = await (
      await post("authenticate", {
        appleId: input.appleId,
        password: "fixture",
      })
    ).json();
    await post("plan", { ...input, attemptToken });
    const events = await (await post("execute", { attemptToken })).text();
    expect(events).toContain('"error":');
    expect(events).not.toContain('"done":true');
  });
});
