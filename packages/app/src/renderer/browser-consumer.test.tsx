import { afterEach, describe, expect, it, vi } from "vitest";

const ports = vi.hoisted(() => ({ hydrate: vi.fn(), publish: vi.fn() }));
vi.mock("../../../ui/src/bridge/storage-bridge.js", () => ({
  initializeStorageBridge: ports.hydrate,
}));
vi.mock("../../../ui/src/bridge/capacitor-bridge.js", () => ({
  initializeCapacitorBridge: ports.publish,
}));
vi.mock("../../../ui/src/app/browser-consumer.js", () => ({}));
vi.mock("@elizaos/ui", () => ({
  ShellModalityProvider: () => null,
  ShellRoleProvider: () => null,
}));
vi.mock("@elizaos/ui/app/AppProvider", () => ({ AppProvider: () => null }));
vi.mock("./App", () => ({ App: () => null }));

vi.mock("./transports/configure", () => ({}));

import {
  configureHostAgentCapabilities,
  hostAgentLifecycleForUrl,
  hostRequestOwnerId,
} from "../../../ui/src/api/host-transport";
import {
  createBrowserConsumerHost,
  initializeBrowserConsumer,
} from "./browser-consumer";

afterEach(() => {
  vi.resetAllMocks();
  configureHostAgentCapabilities({
    isInProcessAgentBase: () => false,
    isTerminalBootError: () => false,
    lifecycleForUrl: async () => null,
  });
});
describe("browser consumer native bootstrap ordering", () => {
  it("does not publish the native bridge while protected storage is still hydrating", async () => {
    let complete!: () => void;
    ports.hydrate.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const bootstrap = initializeBrowserConsumer(createBrowserConsumerHost());
    await vi.waitFor(() => expect(ports.hydrate).toHaveBeenCalledOnce());
    expect(ports.publish).not.toHaveBeenCalled();
    complete();
    await bootstrap;
    expect(ports.publish).toHaveBeenCalledOnce();
  });
  it("propagates failed storage hydration without publishing a partially initialized bridge", async () => {
    const failure = Error("protected storage unavailable");
    ports.hydrate.mockRejectedValue(failure);
    await expect(
      initializeBrowserConsumer(createBrowserConsumerHost()),
    ).rejects.toBe(failure);
    expect(ports.publish).not.toHaveBeenCalled();
  });
  it("preserves the installed capabilities when the host supplies no override", async () => {
    configureHostAgentCapabilities({
      requestOwnerIdForUrl: () => "current-owner",
      isInProcessAgentBase: () => false,
      isTerminalBootError: () => false,
      lifecycleForUrl: async () => null,
    });
    await initializeBrowserConsumer(createBrowserConsumerHost());
    expect(hostRequestOwnerId("https://runtime.test")).toBe("current-owner");
  });
  it("forwards the host's existing owner and lifecycle capability methods", async () => {
    let owner = "owner-a";
    const lifecycle = { getStatus: vi.fn() };
    const lookup = vi.fn(async () => lifecycle);
    await initializeBrowserConsumer(
      createBrowserConsumerHost({
        agentCapabilities: {
          requestOwnerIdForUrl: () => owner,
          isInProcessAgentBase: () => false,
          isTerminalBootError: () => false,
          lifecycleForUrl: lookup,
        },
      }),
    );
    expect(hostRequestOwnerId("eliza-local-agent://ipc")).toBe("owner-a");
    owner = "owner-b";
    expect(hostRequestOwnerId("eliza-local-agent://ipc")).toBe("owner-b");
    expect(await hostAgentLifecycleForUrl("eliza-local-agent://ipc")).toBe(
      lifecycle,
    );
    expect(lookup).toHaveBeenCalledWith("eliza-local-agent://ipc");
    expect(lifecycle.getStatus).not.toHaveBeenCalled();
  });
});
