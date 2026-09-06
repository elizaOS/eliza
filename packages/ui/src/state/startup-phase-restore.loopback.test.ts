/**
 * Exercises persisted desktop connection restoration with real storage and
 * loopback HTTP servers, preserving remote trust boundaries and mobile IPC.
 */
// @vitest-environment jsdom
import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_BOOT_CONFIG, setBootConfig } from "../config/boot-config";
import {
  loadPersistedActiveServer,
  type PersistedActiveServer,
  savePersistedActiveServer,
} from "./persistence";
import { applyRestoredConnection } from "./startup-phase-restore";

afterEach(() => {
  localStorage.clear();
  setBootConfig(DEFAULT_BOOT_CONFIG);
});

it.each([
  ["[::1]", "::1"],
  ["127.0.0.2", "127.0.0.1"],
  ["127.0.0.1", "127.0.0.1"],
])(
  "repairs stale %s and reaches the live desktop server",
  async (savedHost, bindHost) => {
    const server = createServer((_request, response) =>
      response.end("live agent"),
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, bindHost, resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No TCP address");
      const liveHost = bindHost.includes(":") ? `[${bindHost}]` : bindHost;
      const live = `http://${liveHost}:${address.port}`;
      setBootConfig({ ...DEFAULT_BOOT_CONFIG, apiBase: live });
      const saved: PersistedActiveServer = {
        id: "remote:desktop",
        kind: "remote",
        label: "Desktop agent",
        apiBase: `http://${savedHost}:31337`,
      };
      savePersistedActiveServer(saved);
      let clientBase: string | null = null;
      await applyRestoredConnection({
        restoredActiveServer: saved,
        clientRef: {
          setBaseUrl: (base) => {
            clientBase = base;
          },
          setToken: vi.fn(),
        },
      });
      expect(clientBase).toBe(live);
      expect(loadPersistedActiveServer()?.apiBase).toBe(live);
      const response = await fetch(`${clientBase}/api/health`);
      expect(await response.text()).toBe("live agent");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  },
);

it.each([
  ["http://192.168.1.20:4000", "http://127.0.0.1:5000", true],
  ["http://[::1]:4000", "http://192.168.1.20:5000", true],
  ["http://127.0.0.1.evil.example:4000", "http://127.0.0.1:5000", false],
  ["http://localhost.evil.example:4000", "http://127.0.0.1:5000", false],
  ["not a URL", "http://127.0.0.1:5000", false],
])(
  "preserves the restore trust boundary for %s",
  async (savedBase, liveBase, trusted) => {
    setBootConfig({ ...DEFAULT_BOOT_CONFIG, apiBase: liveBase });
    const saved: PersistedActiveServer = {
      id: "remote:other",
      kind: "remote",
      label: "Other",
      apiBase: savedBase,
    };
    savePersistedActiveServer(saved);
    const setBaseUrl = vi.fn();
    await applyRestoredConnection({
      restoredActiveServer: saved,
      clientRef: { setBaseUrl, setToken: vi.fn() },
    });
    if (trusted) {
      expect(setBaseUrl).toHaveBeenCalledWith(savedBase);
      expect(loadPersistedActiveServer()?.apiBase).toBe(savedBase);
    } else {
      expect(setBaseUrl).not.toHaveBeenCalled();
      expect(loadPersistedActiveServer()).toBeNull();
    }
  },
);
