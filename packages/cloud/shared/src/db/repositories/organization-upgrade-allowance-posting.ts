/** Pure posting projection; caller must hold and verify paid source/period authority in one transaction. */
import { ElizaError } from "@elizaos/core";
import {
  moneyToMicros as micros,
  microsToMoney as money,
} from "./subscription-funding-reservations";

type Balances = {
  available_amount: string;
  reserved_amount: string;
  settled_amount: string;
  expired_amount: string;
  clawed_back_amount: string;
};
type Period = Balances & {
  granted_amount: string;
  adjustment_amount: string;
  state: "open" | "expired" | "closed" | "clawed_back";
  expires_at: Date;
};
function reject(): never {
  throw new ElizaError("Allowance posting requires a conserved locked period", {
    code: "SUBSCRIPTION_UPGRADE_ALLOWANCE_CONFLICT",
  });
}
export function projectUpgradeAllowanceAdjustment(
  period: Period,
  additionalUsd: string,
  now: Date,
) {
  const delta = micros(additionalUsd, "additionalAllowanceUsd");
  const granted = micros(period.granted_amount, "granted"),
    adjusted = micros(period.adjustment_amount, "adjusted");
  let available = micros(period.available_amount, "available"),
    expired = micros(period.expired_amount, "expired");
  const reserved = micros(period.reserved_amount, "reserved"),
    settled = micros(period.settled_amount, "settled"),
    clawed = micros(period.clawed_back_amount, "clawed");
  if (
    !Number.isFinite(now.getTime()) ||
    !Number.isFinite(period.expires_at.getTime()) ||
    granted <= 0n ||
    granted + adjusted !== available + reserved + settled + expired + clawed ||
    (period.state !== "open" && available !== 0n) ||
    ((period.state === "closed" || period.state === "clawed_back") && reserved !== 0n)
  )
    reject();
  const expiredNow = period.state !== "open" || period.expires_at <= now;
  const entries: {
    kind: "expire" | "grant_adjustment";
    reason: "period_ended" | "upgrade" | "late_upgrade";
    amount: string;
    before: Balances;
    after: Balances;
  }[] = [];
  const snapshot = (): Balances => ({
    available_amount: money(available),
    reserved_amount: money(reserved),
    settled_amount: money(settled),
    expired_amount: money(expired),
    clawed_back_amount: money(clawed),
  });
  if (expiredNow && available > 0n) {
    const amount = available,
      before = snapshot();
    expired += available;
    available = 0n;
    entries.push({
      kind: "expire",
      reason: "period_ended",
      amount: money(amount),
      before,
      after: snapshot(),
    });
  }
  if (delta > 0n) {
    const before = snapshot();
    available += delta;
    entries.push({
      kind: "grant_adjustment",
      reason: "upgrade",
      amount: additionalUsd,
      before,
      after: snapshot(),
    });
    if (expiredNow) {
      const before = snapshot();
      expired += delta;
      available -= delta;
      entries.push({
        kind: "expire",
        reason: "late_upgrade",
        amount: additionalUsd,
        before,
        after: snapshot(),
      });
    }
  }
  return {
    entries,
    periodChanges: {
      adjustment_amount: money(adjusted + delta),
      ...snapshot(),
      state: period.state === "open" && expiredNow ? ("expired" as const) : period.state,
    },
    expired: expiredNow,
  };
}
