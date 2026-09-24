import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  type LinuxPeerCredentialNativeBinding,
  NativeLinuxUnixPeerCredentialProvider,
} from "./linux-native-peer";

function socketWithDescriptor(fd: number): Socket {
  return { _handle: { fd } } as unknown as Socket;
}

describe("native Linux Unix peer credential provider", () => {
  it("captures the accepted socket synchronously and retains the pidfd", async () => {
    const isAlive = vi.fn(() => true);
    const close = vi.fn();
    const capture = vi.fn(() => ({
      pid: 42,
      uid: 1000,
      gid: 100,
      isAlive,
      close,
    }));
    const provider = new NativeLinuxUnixPeerCredentialProvider({ capture });

    const peer = provider.inspect(socketWithDescriptor(17));

    expect(capture).toHaveBeenCalledWith(17);
    expect(peer).toMatchObject({ uid: 1000, gid: 100, process: { pid: 42 } });
    await expect(peer.process.isAlive()).resolves.toBe(true);
    peer.process.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("fails closed when Node does not expose the accepted descriptor", () => {
    const binding: LinuxPeerCredentialNativeBinding = {
      capture: vi.fn(() => {
        throw new Error("unreachable");
      }),
    };
    const provider = new NativeLinuxUnixPeerCredentialProvider(binding);
    expect(() => provider.inspect({} as Socket)).toThrow(
      "cannot obtain the accepted AF_UNIX socket descriptor",
    );
    expect(binding.capture).not.toHaveBeenCalled();
  });

  it("closes and rejects malformed native results", () => {
    const close = vi.fn();
    const provider = new NativeLinuxUnixPeerCredentialProvider({
      capture: () =>
        ({
          pid: 0,
          uid: 1000,
          gid: 1000,
          isAlive: () => true,
          close,
        }) as never,
    });
    expect(() => provider.inspect(socketWithDescriptor(9))).toThrow(
      "credentials are malformed",
    );
    expect(close).toHaveBeenCalledOnce();
  });
});
