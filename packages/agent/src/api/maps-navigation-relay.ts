/** Transient Maps requests belong to the authenticated phone turn, never the runtime at large. */
import { randomUUID } from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import {
  DeviceActionError,
  DeviceActionService,
  type DeviceCredential,
  getDeviceActionTurn,
} from "@elizaos/plugin-assistant";
import { MapsError, type MapsErrorCode } from "@elizaos/plugin-maps/errors";
import type {
  MapsDeviceNavigation,
  MapsDeviceNavigationStatus,
} from "@elizaos/plugin-maps/navigation";
import { MapsService } from "@elizaos/plugin-maps/service";

type Operation =
  | { kind: "select"; place: Parameters<MapsDeviceNavigation["select"]>[0] }
  | { kind: "start"; request: Parameters<MapsDeviceNavigation["start"]>[0] }
  | { kind: "reroute" | "stop" };
type Turn = NonNullable<ReturnType<typeof getDeviceActionTurn>>;
interface Pending {
  id: string;
  expiresAt: number;
  operation: Operation;
  turn: Turn;
  delivered: boolean;
  finish(value: MapsDeviceNavigationStatus | MapsError): void;
}
interface Offer {
  id: string;
  conversationId: string;
  seenAt: number;
  pending?: Pending;
  wake?: () => void;
}
interface Relay {
  maps: MapsService;
  offers: Map<string, Offer>;
}
const relays = new WeakMap<IAgentRuntime, Relay>();
const unavailable = () =>
  new MapsError(
    "The phone navigation request did not complete. Check the phone before trying again.",
    { code: "MAPS_DEVICE_UNAVAILABLE" },
  );

function relayFor(runtime: IAgentRuntime): Relay {
  const maps = runtime.getService<MapsService>(MapsService.serviceType);
  if (!maps) throw new DeviceActionError("Maps service unavailable");
  const previous = relays.get(runtime);
  if (previous?.maps === maps) return previous;
  for (const offer of previous?.offers.values() ?? [])
    offer.pending?.finish(unavailable());
  const relay: Relay = { maps, offers: new Map() };
  relays.set(runtime, relay);
  const dispatch = async (operation: Operation) => {
    const turn = getDeviceActionTurn();
    if (!turn || turn.runtime !== runtime || !turn.replyConversation)
      throw unavailable();
    const context = await new DeviceActionService(runtime).context(
      turn.credential,
    );
    const offer = relay.offers.get(context.scope);
    if (
      !turn.active ||
      relays.get(runtime) !== relay ||
      !offer ||
      offer.conversationId !== turn.replyConversation.id ||
      Date.now() - offer.seenAt > 2_000 ||
      offer.pending
    )
      throw unavailable();
    return new Promise<MapsDeviceNavigationStatus>((resolve, reject) => {
      const timeout = setTimeout(() => pending.finish(unavailable()), 30_000);
      const pending: Pending = {
        id: randomUUID(),
        expiresAt: Date.now() + 30_000,
        operation,
        turn,
        delivered: false,
        finish(value) {
          clearTimeout(timeout);
          if (offer.pending !== pending) return;
          offer.pending = undefined;
          if (value instanceof MapsError) reject(value);
          else resolve(value);
        },
      };
      offer.pending = pending;
      offer.wake?.();
    });
  };
  maps.registerDeviceNavigation({
    select: (place) => dispatch({ kind: "select", place }),
    start: (request) => dispatch({ kind: "start", request }),
    reroute: () => dispatch({ kind: "reroute" }),
    stop: () => dispatch({ kind: "stop" }),
  });
  return relay;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DeviceActionError("Invalid navigation message");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new DeviceActionError("Invalid navigation fields");
}
function status(
  value: unknown,
  operation: Operation,
): MapsDeviceNavigationStatus {
  const body = object(value);
  keys(body, ["state", "placeName", "travelMode"]);
  const states =
    operation.kind === "select"
      ? ["selected"]
      : operation.kind === "stop"
        ? ["stopped"]
        : operation.kind === "reroute"
          ? ["navigating", "awaiting-location"]
          : ["navigating", "awaiting-location", "awaiting-confirmation"];
  if (
    typeof body.state !== "string" ||
    !states.includes(body.state) ||
    (body.placeName !== undefined &&
      (typeof body.placeName !== "string" ||
        !body.placeName.trim() ||
        body.placeName.length > 300)) ||
    (body.travelMode !== undefined &&
      (typeof body.travelMode !== "string" ||
        !["drive", "walk", "bicycle", "transit"].includes(body.travelMode)))
  )
    throw new DeviceActionError("Invalid navigation status");
  return body as unknown as MapsDeviceNavigationStatus;
}

/** Each call authenticates the current enrollment in the canonical SQL device store. */
export async function handleMapsNavigationRelay(
  runtime: IAgentRuntime,
  credential: DeviceCredential,
  input: unknown,
  recheck?: () => Promise<void>,
) {
  const body = object(input);
  keys(body, ["phase", "conversationId", "offerId", "id", "status", "failed"]);
  if (
    typeof body.offerId !== "string" ||
    !/^[a-f0-9-]{36}$/i.test(body.offerId) ||
    typeof body.conversationId !== "string" ||
    !/^[a-f0-9-]{36}$/i.test(body.conversationId) ||
    typeof body.phase !== "string" ||
    !["open", "poll", "result", "retire"].includes(body.phase)
  )
    throw new DeviceActionError("Invalid navigation request");
  const context = await new DeviceActionService(runtime).context(credential);
  await recheck?.();
  const relay = relayFor(runtime);
  // Expired idle offers are not retained for the life of a resident runtime.
  for (const [scope, offer] of relay.offers) {
    if (Date.now() - offer.seenAt > 30_000) {
      offer.pending?.finish(unavailable());
      relay.offers.delete(scope);
    }
  }
  let offer = relay.offers.get(context.scope);
  if (body.phase === "retire") {
    if (
      offer?.conversationId === body.conversationId &&
      offer.id === body.offerId
    ) {
      offer.pending?.finish(unavailable());
      relay.offers.delete(context.scope);
      offer.wake?.();
    }
    return { protocol: 1, request: null };
  }
  if (body.phase === "poll" || body.phase === "open") {
    if (
      body.id !== undefined ||
      body.status !== undefined ||
      body.failed !== undefined
    )
      throw new DeviceActionError("Invalid navigation poll");
    if (
      offer &&
      (offer.conversationId !== body.conversationId ||
        offer.id !== body.offerId)
    ) {
      if (body.phase !== "open")
        throw new DeviceActionError("Navigation offer retired");
      offer.pending?.finish(unavailable());
      offer.wake?.();
      offer = undefined;
    }
    if (!offer) {
      if (body.phase !== "open")
        throw new DeviceActionError("Navigation offer unavailable");
      offer = {
        id: body.offerId,
        conversationId: body.conversationId,
        seenAt: Date.now(),
      };
      relay.offers.set(context.scope, offer);
    }
    offer.seenAt = Date.now();
    if (body.phase === "open") return { protocol: 1, request: null };
    if (!offer.pending) {
      const waiting = offer;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          if (waiting.wake === done) waiting.wake = undefined;
          resolve();
        };
        const timer = setTimeout(done, 1000);
        waiting.wake = done;
      });
      // Waiting holds no SQL transaction. Recheck authority after the wait and before delivery.
      const fresh = await new DeviceActionService(runtime).context(credential);
      await recheck?.();
      if (
        fresh.scope !== context.scope ||
        relay.offers.get(context.scope) !== offer
      )
        throw new DeviceActionError("Navigation offer retired");
    }
    const pending = offer.pending;
    if (!pending) return { protocol: 1, request: null };
    if (!pending.turn.active || pending.expiresAt <= Date.now()) {
      pending.finish(unavailable());
      return { protocol: 1, request: null };
    }
    if (pending.delivered) return { protocol: 1, request: null };
    // At most one delivery. A lost response is unknown, never an automatic replay.
    pending.delivered = true;
    return {
      protocol: 1,
      request: {
        id: pending.id,
        expiresAt: pending.expiresAt,
        operation: pending.operation,
      },
    };
  }
  const pending = offer?.pending;
  if (
    !offer ||
    offer.conversationId !== body.conversationId ||
    offer.id !== body.offerId ||
    !pending ||
    !pending.delivered ||
    pending.id !== body.id ||
    !pending.turn.active ||
    pending.expiresAt <= Date.now()
  )
    throw new DeviceActionError("Navigation request retired");
  offer.seenAt = Date.now();
  if (body.failed !== undefined && body.status === undefined) {
    const failure = object(body.failed);
    keys(failure, ["code"]);
    const codes: MapsErrorCode[] = [
      "MAPS_DEVICE_UNAVAILABLE",
      "MAPS_INVALID_INPUT",
      "MAPS_NOT_FOUND",
      "MAPS_UNSUPPORTED_REGION",
      "MAPS_AUTH_EXPIRED",
      "MAPS_NOT_ENTITLED",
      "MAPS_PROVIDER_CHANGED",
      "MAPS_RATE_LIMITED",
      "MAPS_PROVIDER_UNAVAILABLE",
      "MAPS_PROVIDER_NETWORK",
      "MAPS_PROVIDER_TIMEOUT",
      "MAPS_MALFORMED_RESPONSE",
    ];
    if (!codes.includes(failure.code as MapsErrorCode))
      throw new DeviceActionError("Invalid navigation failure");
    pending.finish(
      new MapsError(
        "The phone could not complete this Maps request. Check Maps on the phone.",
        { code: failure.code as MapsErrorCode },
      ),
    );
  } else if (body.failed === undefined)
    pending.finish(status(body.status, pending.operation));
  else throw new DeviceActionError("Invalid navigation result");
  return { protocol: 1, request: null };
}
