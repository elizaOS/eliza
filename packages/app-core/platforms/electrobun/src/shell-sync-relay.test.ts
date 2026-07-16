/** Cross-window shell-sync relay routing: broadcast-to-others (never self),
 *  delivery count, and endpoint release. */
import { describe, expect, it, vi } from "vitest";
import {
  broadcastShellSyncEnvelope,
  registerShellSyncEndpoint,
  SHELL_SYNC_PUSH_MESSAGE,
  shellSyncEndpointCount,
} from "./shell-sync-relay";

describe("shell-sync relay", () => {
  it("fans a publish out to every registered window", () => {
    const base = shellSyncEndpointCount();
    const sendA = vi.fn();
    const sendB = vi.fn();
    const a = registerShellSyncEndpoint(sendA);
    const b = registerShellSyncEndpoint(sendB);

    const envelope = { type: "presence", protocolVersion: "1" };
    const delivered = broadcastShellSyncEnvelope(envelope);

    expect(delivered).toBe(base + 2);
    expect(sendA).toHaveBeenCalledWith(SHELL_SYNC_PUSH_MESSAGE, { envelope });
    expect(sendB).toHaveBeenCalledWith(SHELL_SYNC_PUSH_MESSAGE, { envelope });

    a.release();
    b.release();
  });

  it("stops delivering to a released endpoint", () => {
    const base = shellSyncEndpointCount();
    const sendA = vi.fn();
    const sendB = vi.fn();
    const a = registerShellSyncEndpoint(sendA);
    const b = registerShellSyncEndpoint(sendB);
    expect(shellSyncEndpointCount()).toBe(base + 2);

    b.release();
    expect(shellSyncEndpointCount()).toBe(base + 1);

    broadcastShellSyncEnvelope({ x: 1 });
    expect(sendA).toHaveBeenCalledTimes(1);
    expect(sendB).not.toHaveBeenCalled();

    a.release();
  });

  it("release removes the endpoint from the registry", () => {
    const base = shellSyncEndpointCount();
    const a = registerShellSyncEndpoint(vi.fn());
    expect(shellSyncEndpointCount()).toBe(base + 1);
    a.release();
    expect(shellSyncEndpointCount()).toBe(base);
  });
});
