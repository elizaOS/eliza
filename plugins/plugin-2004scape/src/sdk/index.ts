/* ------------------------------------------------------------------ */
/*  2004scape Bot SDK — WebSocket client for the gateway server        */
/* ------------------------------------------------------------------ */

import type {
  BotAction,
  BotWorldState,
  SDKActionAck,
  SyncToSDKMessage,
} from "./types.js";

/** Inbound messages the SDK can receive from the gateway. */
type GatewayInbound = SyncToSDKMessage | SDKActionAck;

interface PendingAction {
  resolve: (ack: SDKActionAck) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const _TICK_MS = 420;
const ACTION_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export class BotSDK {
  private readonly gatewayUrl: string;
  private readonly username: string;
  private readonly password: string;

  private ws: WebSocket | null = null;
  private state: BotWorldState | null = null;
  private connected = false;
  private intentionalClose = false;
  private reconnectDelay = RECONNECT_BASE_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Pending action promises keyed by action ID. */
  private pending = new Map<string, PendingAction>();

  /** Resolvers waiting for the next state tick. */
  private tickWaiters: Array<() => void> = [];

  constructor(gatewayUrl: string, username: string, password: string) {
    this.gatewayUrl = gatewayUrl;
    this.username = username;
    this.password = password;
  }

  /* ---------------------------------------------------------------- */
  /*  Connection lifecycle                                             */
  /* ---------------------------------------------------------------- */

  connect(): void {
    this.intentionalClose = false;
    this.openSocket();
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.clearReconnectTimer();
    this.rejectAllPending("SDK disconnected");
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getState(): BotWorldState | null {
    return this.state;
  }

  /* ---------------------------------------------------------------- */
  /*  WebSocket plumbing                                               */
  /* ---------------------------------------------------------------- */

  private openSocket(): void {
    const sep = this.gatewayUrl.includes("?") ? "&" : "?";
    const url = `${this.gatewayUrl}/sdk${sep}username=${encodeURIComponent(this.username)}`;
    const ws = new WebSocket(url);

    ws.addEventListener("open", () => {
      this.connected = true;
      this.reconnectDelay = RECONNECT_BASE_MS;

      // Authenticate immediately after connecting.
      ws.send(
        JSON.stringify({
          type: "login",
          username: this.username,
          password: this.password,
        }),
      );
    });

    ws.addEventListener("message", (event) => {
      this.handleMessage(event);
    });

    ws.addEventListener("close", () => {
      this.connected = false;
      this.ws = null;
      this.rejectAllPending("WebSocket closed");
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    });

    ws.addEventListener("error", () => {
      // The close handler will fire after this; nothing extra needed.
    });

    this.ws = ws;
  }

  private handleMessage(event: MessageEvent): void {
    let msg: GatewayInbound;
    try {
      msg = JSON.parse(
        typeof event.data === "string" ? event.data : String(event.data),
      );
    } catch {
      return;
    }

    if (msg.type === "sdk_state") {
      this.state = msg.state;
      this.flushTickWaiters();
      return;
    }

    if (msg.type === "sdk_action_ack") {
      const pending = this.pending.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(msg.id);
        pending.resolve(msg);
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Reconnect with exponential backoff                               */
  /* ---------------------------------------------------------------- */

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Tick waiters                                                     */
  /* ---------------------------------------------------------------- */

  private flushTickWaiters(): void {
    const waiters = this.tickWaiters.splice(0);
    for (const resolve of waiters) {
      resolve();
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Generic action send                                              */
  /* ---------------------------------------------------------------- */

  sendAction(action: BotAction): Promise<SDKActionAck> {
    return new Promise<SDKActionAck>((resolve, reject) => {
      if (!this.ws || !this.connected) {
        reject(new Error("Not connected to gateway"));
        return;
      }

      const id = crypto.randomUUID();

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Action timed out after ${ACTION_TIMEOUT_MS}ms: ${action.type}`,
          ),
        );
      }, ACTION_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });

      this.ws.send(JSON.stringify({ type: "sdk_action", action, id }));
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Utility methods                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * Resolves once the predicate returns true for the current state.
   * Polls on each incoming state tick.
   */
  waitForState(
    predicate: (state: BotWorldState) => boolean,
    timeoutMs = 30_000,
  ): Promise<BotWorldState> {
    return new Promise<BotWorldState>((resolve, reject) => {
      // Check immediately.
      if (this.state && predicate(this.state)) {
        resolve(this.state);
        return;
      }

      const deadline = Date.now() + timeoutMs;
      let cancelled = false;

      const check = (): void => {
        if (cancelled) return;
        if (Date.now() > deadline) {
          cancelled = true;
          reject(new Error("waitForState timed out"));
          return;
        }
        if (this.state && predicate(this.state)) {
          cancelled = true;
          resolve(this.state);
          return;
        }
        // Wait for next tick, then re-check.
        this.waitForNextTick().then(check, () => {
          if (!cancelled) {
            cancelled = true;
            reject(new Error("waitForState aborted — tick wait failed"));
          }
        });
      };

      // Kick off the polling loop on the next tick.
      this.waitForNextTick().then(check, reject);
    });
  }

  /** Waits for the specified number of game ticks. */
  async waitForTicks(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await this.waitForNextTick();
    }
  }

  /** Resolves on the next incoming `sdk_state` message. */
  private waitForNextTick(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.tickWaiters.push(resolve);
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Pending-action housekeeping                                      */
  /* ---------------------------------------------------------------- */

  private rejectAllPending(reason: string): void {
    for (const [_id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  /* ---------------------------------------------------------------- */
  /*  Typed action helpers                                             */
  /* ---------------------------------------------------------------- */

  sendWalk(x: number, z: number, reason?: string): Promise<SDKActionAck> {
    return this.sendAction({ type: "walkTo", x, z, reason });
  }

  sendInteractLoc(locId: number, opIndex?: number): Promise<SDKActionAck> {
    return this.sendAction({ type: "interactLoc", locId, opIndex });
  }

  sendInteractNpc(nid: number, opIndex?: number): Promise<SDKActionAck> {
    return this.sendAction({ type: "interactNpc", nid, opIndex });
  }

  sendAttackNpc(nid: number): Promise<SDKActionAck> {
    return this.sendAction({ type: "attackNpc", nid });
  }

  sendTalkToNpc(nid: number): Promise<SDKActionAck> {
    return this.sendAction({ type: "talkToNpc", nid });
  }

  sendUseInventory(slot: number): Promise<SDKActionAck> {
    return this.sendAction({ type: "useInventory", slot });
  }

  sendEquipItem(slot: number): Promise<SDKActionAck> {
    return this.sendAction({ type: "equipItem", slot });
  }

  sendUnequipItem(slot: number): Promise<SDKActionAck> {
    return this.sendAction({ type: "unequipItem", slot });
  }

  sendDropItem(slot: number): Promise<SDKActionAck> {
    return this.sendAction({ type: "dropItem", slot });
  }

  sendPickupItem(id: number, x: number, z: number): Promise<SDKActionAck> {
    return this.sendAction({ type: "pickupItem", id, x, z });
  }

  sendUseItemOnItem(slot1: number, slot2: number): Promise<SDKActionAck> {
    return this.sendAction({ type: "useItemOnItem", slot1, slot2 });
  }

  sendUseItemOnLoc(slot: number, locId: number): Promise<SDKActionAck> {
    return this.sendAction({ type: "useItemOnLoc", slot, locId });
  }

  sendUseItemOnNpc(slot: number, nid: number): Promise<SDKActionAck> {
    return this.sendAction({ type: "useItemOnNpc", slot, nid });
  }

  sendDialogOption(option: number): Promise<SDKActionAck> {
    return this.sendAction({ type: "dialogOption", option });
  }

  sendOpenBank(): Promise<SDKActionAck> {
    return this.sendAction({ type: "openBank" });
  }

  sendCloseBank(): Promise<SDKActionAck> {
    return this.sendAction({ type: "closeBank" });
  }

  sendDepositItem(slot: number, count: number): Promise<SDKActionAck> {
    return this.sendAction({ type: "depositItem", slot, count });
  }

  sendWithdrawItem(slot: number, count: number): Promise<SDKActionAck> {
    return this.sendAction({ type: "withdrawItem", slot, count });
  }

  sendOpenShop(nid: number): Promise<SDKActionAck> {
    return this.sendAction({ type: "openShop", nid });
  }

  sendCloseShop(): Promise<SDKActionAck> {
    return this.sendAction({ type: "closeShop" });
  }

  sendBuyItem(slot: number, count: number): Promise<SDKActionAck> {
    return this.sendAction({ type: "buyItem", slot, count });
  }

  sendSellItem(slot: number, count: number): Promise<SDKActionAck> {
    return this.sendAction({ type: "sellItem", slot, count });
  }

  sendSetCombatStyle(style: number): Promise<SDKActionAck> {
    return this.sendAction({ type: "setCombatStyle", style });
  }

  sendCastSpell(spellId: number, targetNid?: number): Promise<SDKActionAck> {
    return this.sendAction({ type: "castSpell", spellId, targetNid });
  }
}
