/**
 * Tests for @milaidy/capacitor-gateway — WebSocket RPC and discovery.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { GatewayWeb } from "../../plugins/gateway/src/web";

type Internals = GatewayWeb & {
  pending: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timeout: ReturnType<typeof setTimeout> }>;
  closed: boolean;
  backoffMs: number;
  lastSeq: number | null;
  options: Record<string, unknown> | null;
  handleMessage: (raw: string) => void;
  handleClose: (code: number, reason: string) => void;
};

describe("@milaidy/capacitor-gateway", () => {
  let gw: GatewayWeb;
  let priv: Internals;

  beforeEach(() => {
    vi.useFakeTimers();
    gw = new GatewayWeb();
    priv = gw as unknown as Internals;
  });

  afterEach(() => vi.useRealTimers());

  // -- Discovery (web: no Bonjour/mDNS) --

  describe("discovery", () => {
    it("returns empty gateways with descriptive status", async () => {
      const r = await gw.startDiscovery();
      expect(r.gateways).toEqual([]);
      expect(r.status).toMatch(/not supported/i);
    });

    it("startDiscovery with options still returns empty", async () => {
      expect((await gw.startDiscovery({ wideAreaDomain: "x", timeout: 5000 })).gateways).toEqual([]);
    });

    it("stopDiscovery/getDiscoveredGateways are no-ops", async () => {
      await expect(gw.stopDiscovery()).resolves.toBeUndefined();
      expect((await gw.getDiscoveredGateways()).gateways).toHaveLength(0);
    });
  });

  // -- Connection state --

  describe("connection state", () => {
    it("starts disconnected with null info", async () => {
      expect((await gw.isConnected()).connected).toBe(false);
      expect(await gw.getConnectionInfo()).toEqual({ url: null, sessionId: null, protocol: null, role: null });
    });

    it("disconnect is idempotent", async () => {
      await gw.disconnect();
      await gw.disconnect();
      expect((await gw.isConnected()).connected).toBe(false);
    });
  });

  // -- Send without connection --

  describe("send without connection", () => {
    it.each([
      ["empty method", { method: "" }],
      ["method with params", { method: "chat.send", params: { text: "hi" } }],
    ])("returns NOT_CONNECTED for %s", async (_label, opts) => {
      const r = await gw.send(opts);
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("NOT_CONNECTED");
    });
  });

  // -- Message frame parsing --

  describe("handleMessage", () => {
    it.each(["not json", "{bad", "", '"string"', "42", "null", "[]"])(
      "ignores invalid input: %s",
      (raw) => { priv.handleMessage(raw); /* no throw */ },
    );

    it("ignores objects without type", () => {
      priv.handleMessage(JSON.stringify({ id: "x" }));
    });

    it("resolves pending request on response frame", () => {
      const resolve = vi.fn();
      priv.pending.set("r1", { resolve, reject: vi.fn(), timeout: setTimeout(() => {}, 60000) });

      priv.handleMessage(JSON.stringify({ type: "res", id: "r1", ok: true, payload: { text: "hi" } }));

      expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ ok: true, payload: { text: "hi" } }));
      expect(priv.pending.has("r1")).toBe(false);
    });

    it("resolves with error info on failed response", () => {
      const resolve = vi.fn();
      priv.pending.set("r2", { resolve, reject: vi.fn(), timeout: setTimeout(() => {}, 60000) });

      priv.handleMessage(JSON.stringify({ type: "res", id: "r2", ok: false, error: { code: "BAD", message: "nope" } }));

      expect(resolve.mock.calls[0][0].error).toEqual({ code: "BAD", message: "nope" });
    });

    it("silently ignores response for unknown request id", () => {
      priv.handleMessage(JSON.stringify({ type: "res", id: "unknown", ok: true }));
    });

    it("tracks sequence and warns on gap", () => {
      priv.lastSeq = 5;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      priv.handleMessage(JSON.stringify({ type: "event", event: "x", seq: 8 }));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("sequence gap"));
      expect(priv.lastSeq).toBe(8);

      warn.mockClear();
      priv.handleMessage(JSON.stringify({ type: "event", event: "x", seq: 9 }));
      expect(warn).not.toHaveBeenCalled();

      warn.mockRestore();
    });

    it("ignores event frames missing event name or response frames missing id", () => {
      priv.handleMessage(JSON.stringify({ type: "event", payload: {} }));
      priv.handleMessage(JSON.stringify({ type: "res", ok: true }));
    });
  });

  // -- Close handling --

  describe("handleClose", () => {
    it("rejects all pending requests", () => {
      const rej1 = vi.fn(), rej2 = vi.fn();
      priv.pending.set("a", { resolve: vi.fn(), reject: rej1, timeout: setTimeout(() => {}, 1000) });
      priv.pending.set("b", { resolve: vi.fn(), reject: rej2, timeout: setTimeout(() => {}, 1000) });
      priv.closed = true;

      priv.handleClose(1006, "Abnormal");

      expect(rej1).toHaveBeenCalled();
      expect(rej2).toHaveBeenCalled();
      expect(priv.pending.size).toBe(0);
    });
  });

  // -- Backoff --

  it("initial backoff is 800ms", () => {
    expect(priv.backoffMs).toBe(800);
  });

  // -- Event listeners --

  describe("event listeners", () => {
    it.each(["gatewayEvent", "stateChange", "error", "discovery"] as const)(
      "registers/removes %s listener",
      async (event) => {
        const h = await gw.addListener(event, vi.fn());
        expect(typeof h.remove).toBe("function");
        await h.remove();
      },
    );

    it("removeAllListeners clears all", async () => {
      await gw.addListener("gatewayEvent", vi.fn());
      await gw.addListener("error", vi.fn());
      await gw.removeAllListeners();
    });
  });
});
