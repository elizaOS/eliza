/**
 * useViewEvent / useEmitViewEvent
 *
 * React wrappers around the framework-agnostic view event bus.
 * These hooks handle subscription lifecycle (setup / teardown in useEffect)
 * and give components a stable emit function.
 */
import { type DependencyList } from "react";
import { type ViewEvent, type ViewEventPayload } from "../views/view-event-bus";
/**
 * Subscribe to a view event type inside a React component.
 *
 * The handler is captured via a ref so inline arrow functions do not trigger
 * re-subscription on every render. The subscription is torn down on unmount
 * and re-established when `type` or items in `deps` change.
 *
 * @param type    Event type string, e.g. VIEW_EVENTS.WALLET_BALANCE_UPDATED.
 * @param handler Called each time an event of that type is received.
 * @param deps    Additional deps that should trigger re-subscription (optional).
 */
export declare function useViewEvent(
  type: string,
  handler: (event: ViewEvent) => void,
  deps?: DependencyList,
): void;
/**
 * Returns a stable `emit` function that components can call to broadcast a
 * view event. The returned function reference is memoised and does not change
 * between renders.
 */
export declare function useEmitViewEvent(): (
  type: string,
  payload?: ViewEventPayload,
  sourceViewId?: string,
) => void;
//# sourceMappingURL=useViewEvent.d.ts.map
