// spec/wallet/custody.md, "Story: Hold my own keys on my device"
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import type { Driver, Options } from "../../gen/wallet__custody.conformance.ts";
import type { Custody } from "../../gen/wallet__custody.ts";
import { openWallet, type Wallet } from "../../src/index.vibe";

type View = Pick<Custody, "held" | "on">;
const view = ({ held, on }: Custody): View => ({ held, on });

interface Holder {
  readonly dir: string;
  readonly wallet: Wallet;
}

const holders = new Map<string, Holder>();
const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer);

async function holderOf(key: string): Promise<Holder> {
  const existing = holders.get(key);
  if (existing !== undefined) return existing;
  const dir = mkdtempSync(join(tmpdir(), "wallet-custody-"));
  const wallet = await Effect.runPromise(
    Effect.provide(
      openWallet({
        agentId: `agent-${key}`,
        ownerId: `owner-${key}`,
        stateDirectory: dir,
        storageKey: randomBytes(32),
        setting: () => "",
        ownerPresent: () => Promise.resolve(true),
      }),
      platform,
    ),
  );
  const created: Holder = { dir, wallet };
  holders.set(key, created);
  return created;
}

export const driver: Driver<View> = {
  reset() {
    for (const holder of holders.values()) rmSync(holder.dir, { recursive: true, force: true });
    holders.clear();
  },
  async dispatch(key, event, by) {
    const { wallet } = await holderOf(key);
    switch (event.type) {
      case "adopt": {
        if (by !== "Owner" || !event.sealed || event.evmAccount === "" || event.solanaAccount === "") return "refused";
        const before = await Effect.runPromise(wallet.status());
        if (before.custody === "ready" || before.custody === "off") return "refused";
        const res = await Effect.runPromise(Effect.result(wallet.create()));
        return res._tag === "Success" ? "accepted" : "refused";
      }
      case "switchWallet": {
        if (by !== "Owner") return "refused";
        const before = await Effect.runPromise(wallet.status());
        const isHeld = before.custody === "ready" || before.custody === "off";
        const isOn = before.custody === "ready";
        if (!isHeld || isOn === event.wanted) return "refused";
        const res = await Effect.runPromise(Effect.result(wallet.switchTo(event.wanted)));
        return res._tag === "Success" ? "accepted" : "refused";
      }
      default: {
        const unreachable: never = event;
        return unreachable;
      }
    }
  },
  async observe(key): Promise<View> {
    const { wallet } = await holderOf(key);
    const status = await Effect.runPromise(wallet.status());
    return {
      held: status.custody === "ready" || status.custody === "off",
      on: status.custody === "ready",
    };
  },
};

export const options: Options<View> = { view, keys: ["owner"], walks: 20 };
