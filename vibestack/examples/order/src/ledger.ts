//@ backend dafny
// spec/index.md, "The amount paid is never negative and never more than is due"; spec/index.md, "A paid order is paid in full, and something was owed on it"
import { type Event, type Order, initial, step } from "../gen/index.ts";

/** Rebuild an order from its event log. Events the rules reject are skipped. */
export function replay(events: Event[]): Order {
  //@ ensures inv(\result)
  let order: Order = initial;
  let i = 0;
  while (i < events.length) {
    //@ invariant 0 <= i && i <= events.length
    //@ invariant inv(order)
    order = step(order, events[i]);
    i = i + 1;
  }
  return order;
}

/** What the shopper still owes. */
//@ pure
export function balance(order: Order): number {
  //@ requires inv(order)
  //@ ensures \result >= 0
  //@ ensures order.status === "Paid" ==> \result === 0
  //@ ensures (order.status === "Pending" || order.status === "OnHold") ==> \result > 0
  return order.due - order.paid;
}
