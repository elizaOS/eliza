/**
 * Proves that a timed-out SSH exec becomes a transport quiescence boundary,
 * including callbacks whose channels arrive after the caller sees rejection.
 */

import { describe, expect, mock, test } from "bun:test";
import type { ClientChannel, Client as SSHClientType } from "ssh2";
import { DockerSSHClient } from "./docker-ssh";

type ExecCallback = (error: Error | undefined, stream: ClientChannel) => void;

type DockerSshHarness = DockerSSHClient & {
  client: SSHClientType | null;
  connected: boolean;
};

function connectedClient(exec: SSHClientType["exec"]): {
  client: DockerSshHarness;
  destroyTransport: ReturnType<typeof mock>;
  endTransport: ReturnType<typeof mock>;
} {
  const destroyTransport = mock(() => {});
  const endTransport = mock(() => {});
  const transport = {
    destroy: destroyTransport,
    end: endTransport,
    exec,
  } as unknown as SSHClientType;
  const client = new DockerSSHClient({
    hostname: "node.example.test",
    privateKey: Buffer.from("unused"),
    hostKeyFingerprint: "pinned-fingerprint",
  }) as DockerSshHarness;
  client.client = transport;
  client.connected = true;
  return { client, destroyTransport, endTransport };
}

function lateChannel(): {
  channel: ClientChannel;
  destroyChannel: ReturnType<typeof mock>;
  endInput: ReturnType<typeof mock>;
} {
  const destroyChannel = mock(() => {});
  const endInput = mock(() => {});
  return {
    channel: {
      destroy: destroyChannel,
      end: endInput,
    } as unknown as ClientChannel,
    destroyChannel,
    endInput,
  };
}

describe("DockerSSHClient timeout quiescence", () => {
  test("destroys the transport and any exec channel delivered after timeout", async () => {
    let callback: ExecCallback | undefined;
    const exec = mock((_command: string, captured: ExecCallback) => {
      callback = captured;
    }) as unknown as SSHClientType["exec"];
    const { client, destroyTransport, endTransport } = connectedClient(exec);

    await expect(client.exec("docker create --name candidate image", 1)).rejects.toThrow(
      "Command timed out",
    );

    expect(destroyTransport).toHaveBeenCalledTimes(1);
    expect(endTransport).not.toHaveBeenCalled();
    expect(client.isConnected).toBe(false);

    const { channel, destroyChannel } = lateChannel();
    expect(callback).toBeDefined();
    callback?.(undefined, channel);
    expect(destroyChannel).toHaveBeenCalledTimes(1);
  });

  test("never writes stdin into an exec channel delivered after timeout", async () => {
    let callback: ExecCallback | undefined;
    const exec = mock((_command: string, captured: ExecCallback) => {
      callback = captured;
    }) as unknown as SSHClientType["exec"];
    const { client, destroyTransport } = connectedClient(exec);

    await expect(
      client.execStdin("docker load", Buffer.from("container-bytes"), 1),
    ).rejects.toThrow("Command timed out");

    expect(destroyTransport).toHaveBeenCalledTimes(1);
    const { channel, destroyChannel, endInput } = lateChannel();
    expect(callback).toBeDefined();
    callback?.(undefined, channel);
    expect(destroyChannel).toHaveBeenCalledTimes(1);
    expect(endInput).not.toHaveBeenCalled();
  });
});
