/** Generic event callback used across Capacitor/Electrobun plugin bridges. */
export type EventCallback<T = unknown> = (event: T) => void;

/** Generic listener entry used by Electrobun plugin bridges. */
export interface ListenerEntry<
  TEventName extends string = string,
  TEventData = unknown,
> {
  eventName: TEventName;
  callback: EventCallback<TEventData>;
}
