import { BotSDK } from "../sdk/index.js";
import type { BotAlert, BotState, BotWorldState } from "../sdk/types.js";

const FOOD_ITEMS = [
  "shrimp",
  "anchovies",
  "bread",
  "meat",
  "chicken",
  "trout",
  "salmon",
  "tuna",
  "lobster",
  "swordfish",
  "cake",
  "pie",
];

export class BotManager {
  private sdk: BotSDK | null = null;
  private gatewayUrl: string;
  private username: string;
  private password: string;

  constructor(gatewayUrl: string, username: string, password: string) {
    this.gatewayUrl = gatewayUrl;
    this.username = username;
    this.password = password;
  }

  connect(): void {
    if (this.sdk?.isConnected()) return;
    this.sdk = new BotSDK(this.gatewayUrl, this.username, this.password);
    this.sdk.connect();
  }

  async disconnect(): Promise<void> {
    this.sdk?.disconnect();
    this.sdk = null;
  }

  isConnected(): boolean {
    return this.sdk?.isConnected() ?? false;
  }

  getSDK(): BotSDK | null {
    return this.sdk;
  }

  getWorldState(): BotWorldState | null {
    return this.sdk?.getState() ?? null;
  }

  getBotState(): BotState | null {
    const world = this.getWorldState();
    if (!world) {
      return {
        connected: false,
        inGame: false,
        player: null,
        skills: [],
        inventory: [],
        equipment: [],
        nearbyNpcs: [],
        nearbyLocs: [],
        groundItems: [],
        gameMessages: [],
        combatEvents: [],
        dialog: null,
        shop: null,
        bank: null,
        combatStyle: null,
        alerts: [],
      };
    }

    const alerts = this.computeAlerts(world);

    return {
      connected: true,
      inGame: world.inGame,
      player: world.player,
      skills: world.skills,
      inventory: world.inventory,
      equipment: world.equipment,
      nearbyNpcs: world.nearbyNpcs,
      nearbyLocs: world.nearbyLocs,
      groundItems: world.groundItems,
      gameMessages: world.gameMessages,
      combatEvents: world.combatEvents,
      dialog: world.dialog,
      shop: world.shop,
      bank: world.bank,
      combatStyle: world.combatStyle,
      alerts,
    };
  }

  private computeAlerts(world: BotWorldState): BotAlert[] {
    const alerts: BotAlert[] = [];
    const p = world.player;

    if (world.inventory.length >= 28) {
      alerts.push({
        type: "inventory_full",
        message: "Inventory is full (28/28).",
      });
    } else if (world.inventory.length >= 25) {
      alerts.push({
        type: "inventory_nearly_full",
        message: `Inventory nearly full (${world.inventory.length}/28).`,
      });
    }

    if (p) {
      if (p.hp < p.maxHp * 0.3) {
        alerts.push({
          type: "low_hp",
          message: `HP critically low (${p.hp}/${p.maxHp}).`,
        });
      }

      if (p.inCombat) {
        alerts.push({
          type: "in_combat",
          message: `In combat${p.combatTarget ? ` with ${p.combatTarget}` : ""}.`,
        });
      }

      const hasFood = world.inventory.some((item) =>
        FOOD_ITEMS.some((food) => item.name.toLowerCase().includes(food)),
      );
      if (!hasFood && p.hp < p.maxHp) {
        alerts.push({
          type: "no_food",
          message: "No food in inventory and HP is not full.",
        });
      }
    }

    return alerts;
  }
}
