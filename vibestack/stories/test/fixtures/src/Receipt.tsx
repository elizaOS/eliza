import type { Order } from "../gen/index.ts";

/**
 * What an order came to.
 * @model spec/index.md
 * @design design.md#receipt
 */
export function Receipt({ order, compact }: { order: Order; compact?: boolean }) {
  return <p data-compact={compact}>{order.status}: {order.units}</p>;
}
