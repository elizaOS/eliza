/**
 * Unit coverage for the SSH runtime transport: pseudo-URL gating against the
 * persisted agent-profile registry, request shaping handed to the native SSH
 * tunnel, and the method/body guards. Real jsdom storage and real shared
 * header/body helpers; only the desktop bridge call is doubled.
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestSshRuntime } from "../platform/ssh-runtime";
import { sshRuntimeTransportForUrl } from "./ssh-runtime-transport";

vi.mock("../platform/ssh-runtime", () => ({
  requestSshRuntime: vi.fn(),
}));

const requestSshRuntimeMock = vi.mocked(requestSshRuntime);
const REGISTRY_KEY = "elizaos:agent-profiles";

function seedRegistry(profiles: Array<Record<string, unknown>>): void {
  localStorage.setItem(
    REGISTRY_KEY,
    JSON.stringify({
      version: 1,
      activeProfileId: null,
      profiles,
    }),
  );
}

function sshProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: "rt-ssh",
    label: "Tunnelled runtime",
    kind: "remote",
    connectionMode: "ssh",
    credentialRef: "keychain:rt-ssh",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function requireSshTransport(url: string) {
  const transport = sshRuntimeTransportForUrl(url);
  if (!transport) throw new Error("expected a transport for an eligible URL");
  return transport;
}

beforeEach(() => {
  localStorage.clear();
  requestSshRuntimeMock.mockReset();
});

describe("sshRuntimeTransportForUrl", () => {
  describe("pseudo-URL gating", () => {
    it("returns null for an unparseable pseudo-URL", () => {
      expect(sshRuntimeTransportForUrl("not a url")).toBeNull();
    });

    it("returns null when the protocol is not eliza-ssh:", () => {
      expect(sshRuntimeTransportForUrl("https://runtime/rt-ssh")).toBeNull();
    });

    it("returns null when the hostname is not runtime", () => {
      expect(
        sshRuntimeTransportForUrl("eliza-ssh://other-host/rt-ssh"),
      ).toBeNull();
    });

    it("returns null when the pseudo-URL carries no runtime id segment", () => {
      expect(sshRuntimeTransportForUrl("eliza-ssh://runtime/")).toBeNull();
    });
  });

  describe("profile resolution", () => {
    it("returns null when no stored profile matches the runtime id", () => {
      seedRegistry([sshProfile({ id: "some-other-runtime" })]);
      expect(
        sshRuntimeTransportForUrl("eliza-ssh://runtime/rt-ssh"),
      ).toBeNull();
    });

    it("returns null when the matching profile is not in ssh connection mode", () => {
      seedRegistry([sshProfile({ connectionMode: "direct" })]);
      expect(
        sshRuntimeTransportForUrl("eliza-ssh://runtime/rt-ssh"),
      ).toBeNull();
    });

    it("skips a non-ssh row and resolves the ssh-mode profile with that row's credentials", () => {
      seedRegistry([
        sshProfile({
          credentialRef: "keychain:not-this-one",
          connectionMode: "direct",
        }),
        sshProfile(),
      ]);
      const transport = requireSshTransport("eliza-ssh://runtime/rt-ssh");
      requestSshRuntimeMock.mockResolvedValue({
        status: 200,
        statusText: "OK",
        headers: {},
        body: "",
      });

      transport.request("https://gateway.invalid/rt-ssh/api/status", {});

      expect(requestSshRuntimeMock).toHaveBeenCalledWith(
        expect.objectContaining({ credentialRef: "keychain:rt-ssh" }),
      );
    });
  });

  describe("request dispatch through the tunnel", () => {
    function tunnelResult() {
      return {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: '{"ok":true}',
      };
    }

    it("strips the runtime prefix segment, keeps search params, and defaults to GET with a 30s timeout", async () => {
      seedRegistry([sshProfile()]);
      const transport = requireSshTransport("eliza-ssh://runtime/rt-ssh");
      requestSshRuntimeMock.mockResolvedValue(tunnelResult());

      const response = await transport.request(
        "https://gateway.invalid/rt-ssh/api/agents?limit=5",
        {},
      );

      expect(requestSshRuntimeMock).toHaveBeenCalledTimes(1);
      expect(requestSshRuntimeMock).toHaveBeenCalledWith({
        runtimeId: "rt-ssh",
        credentialRef: "keychain:rt-ssh",
        path: "/api/agents?limit=5",
        method: "GET",
        headers: {},
        body: null,
        timeoutMs: 30_000,
      });
      expect(response.status).toBe(200);
      expect(response.statusText).toBe("OK");
      expect(response.headers.get("content-type")).toBe("application/json");
      await expect(response.text()).resolves.toBe('{"ok":true}');
    });

    it("collapses a single-segment request path to the root path plus its search", async () => {
      seedRegistry([sshProfile()]);
      const transport = requireSshTransport("eliza-ssh://runtime/rt-ssh");
      requestSshRuntimeMock.mockResolvedValue(tunnelResult());

      await transport.request("https://gateway.invalid/rt-only?keep=1", {});

      expect(requestSshRuntimeMock).toHaveBeenCalledWith(
        expect.objectContaining({ path: "/?keep=1" }),
      );
    });

    it("uppercases an explicit lowercase method, coerces headers, honors context.timeoutMs, and forwards string bodies", async () => {
      seedRegistry([sshProfile()]);
      const transport = requireSshTransport("eliza-ssh://runtime/rt-ssh");
      requestSshRuntimeMock.mockResolvedValue(tunnelResult());

      await transport.request(
        "https://gateway.invalid/rt-ssh/api/agents",
        {
          method: "post",
          headers: new Headers({ "X-Traced": "1" }),
          body: '{"name":"scout"}',
        },
        { timeoutMs: 1234 },
      );

      expect(requestSshRuntimeMock).toHaveBeenCalledWith({
        runtimeId: "rt-ssh",
        credentialRef: "keychain:rt-ssh",
        path: "/api/agents",
        method: "POST",
        headers: { "x-traced": "1" },
        body: '{"name":"scout"}',
        timeoutMs: 1234,
      });
    });

    it("serializes URLSearchParams bodies through the shared body helper", async () => {
      seedRegistry([sshProfile()]);
      const transport = requireSshTransport("eliza-ssh://runtime/rt-ssh");
      requestSshRuntimeMock.mockResolvedValue(tunnelResult());

      await transport.request("https://gateway.invalid/rt-ssh/api/token", {
        method: "POST",
        body: new URLSearchParams({ grant: "refresh" }),
      });

      expect(requestSshRuntimeMock).toHaveBeenCalledWith(
        expect.objectContaining({ body: "grant=refresh" }),
      );
    });

    it("rejects methods outside the tunnel allowlist without contacting the bridge", async () => {
      seedRegistry([sshProfile()]);
      const transport = requireSshTransport("eliza-ssh://runtime/rt-ssh");

      await expect(
        transport.request("https://gateway.invalid/rt-ssh/api/agents", {
          method: "PUT",
        }),
      ).rejects.toThrow("The SSH runtime does not allow PUT requests.");
      expect(requestSshRuntimeMock).not.toHaveBeenCalled();
    });

    it("rejects byte-shaped bodies instead of silently dropping them", async () => {
      seedRegistry([sshProfile()]);
      const transport = requireSshTransport("eliza-ssh://runtime/rt-ssh");

      await expect(
        transport.request("https://gateway.invalid/rt-ssh/api/upload", {
          method: "POST",
          body: new Blob(["raw-bytes"]),
        }),
      ).rejects.toThrow("The SSH runtime supports text request bodies only.");
      expect(requestSshRuntimeMock).not.toHaveBeenCalled();
    });
  });
});
