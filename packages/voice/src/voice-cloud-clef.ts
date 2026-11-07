/**
 * The Cloud Clef end-of-turn stage (`@elizaos/voice/cloud-clef`): binds Eliza Cloud's Clef `turn`
 * decision (`POST /api/v1/decisions`, client `createClefDecisionsClient` from
 * `@elizaos/cloud-sdk/clef-decisions`) into the endpoint chain's `clef` slot.
 *
 * {@link createCloudClefEndpointStage} returns a {@link ClefEndpointStage}. The stage is left out of
 * the chain entirely (`enabled: false`, `client: null`) unless the host enables Clef explicitly and
 * supplies a Cloud client. Otherwise it is built once and asks its ports on every turn, before
 * anything is sent, so a session that goes offline, signs out or loses its plan falls back without
 * being rebuilt:
 *
 *  - offline                  -> `clef-unavailable`
 *  - no Cloud credential      -> `clef-disabled`
 *  - no active plan / unknown entitlement port -> `clef-disabled`
 *
 * A blocked turn sends nothing; the chain answers `unavailable` on the `clef` path, so the timing
 * record still names the path and the session's long gap submits. The local scorer, when present,
 * is always asked first and is never affected by this gate.
 *
 * Plan state comes from the host's billing reader: `planAdmission(view)` from
 * `@elizaos/cloud-sdk/subscription-entitlement` over the view its `EntitlementRefresher` (or the
 * `cloud-account-billing` reader) last published. The gate reads that cached state only; it never
 * makes a billing request on the turn path. `unknown` (still checking, a billing outage, a lapsed
 * entitlement that could not be refreshed) admits the request, because Cloud still authorizes
 * each Clef call itself and answers `unavailable` when it refuses; `needs-plan` blocks.
 *
 * Pure module: no DOM, storage, network, logging or Cloud SDK import. The host supplies the ports.
 */
import {
  type ClefEndpointStage,
  type ClefEndpointUnavailableReason,
  type ClefTurnClient,
  type ClefTurnRequest,
  clefEndpointStageEnabled,
} from "./voice-endpoint-chain.js";

/** `PlanAdmission` from `@elizaos/cloud-sdk/subscription-entitlement`, restated to keep this module free of imports. */
export type CloudClefPlanAdmission =
  | "admit"
  | "admit-with-warning"
  | "needs-plan"
  | "unknown";

/** Why the Cloud Clef stage does not ask Cloud for this turn. */
export type CloudClefBlock =
  /** The Clef switch is off. */
  | "disabled"
  /** No Cloud client was bound. */
  | "no-client"
  /** The device is offline. */
  | "offline"
  /** No Cloud credential (signed out, or the key was revoked). */
  | "no-credential"
  /** No active plan, or the host gave no plan state. */
  | "no-plan";

/** How each block appears in the chain answer and the timing record. */
export const CLOUD_CLEF_BLOCK_REASONS: Readonly<
  Record<CloudClefBlock, ClefEndpointUnavailableReason>
> = Object.freeze({
  disabled: "clef-disabled",
  "no-client": "clef-disabled",
  offline: "clef-unavailable",
  "no-credential": "clef-disabled",
  "no-plan": "clef-disabled",
});

export interface CloudClefStageOptions {
  /** The explicit Clef switch. Anything but `true` leaves the stage out. */
  enabled: boolean;
  /** `createClefDecisionsClient(...)` bound to the signed-in Cloud credential, or null. */
  client: ClefTurnClient | null | undefined;
  /** Whether the device is online now (for example `navigator.onLine` or the native network state). */
  isOnline(): boolean;
  /** Whether a usable Cloud credential is held now. */
  hasCredential(): boolean;
  /** The plan gate's current answer (`planAdmission(view)`); null when no plan state is known to the host. */
  entitlement(): CloudClefPlanAdmission | null | undefined;
  /** Recent text turns, oldest first. The chain sends at most 6, each reduced to speaker and text. */
  recentTurns?(): ClefTurnRequest["recentTurns"];
  /** Clef stage budget; defaults to the chain's `CLEF_ENDPOINT_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export type CloudClefStatus =
  | { ready: true }
  | {
      ready: false;
      block: CloudClefBlock;
      reason: ClefEndpointUnavailableReason;
    };

const ADMITTED: readonly CloudClefPlanAdmission[] = [
  "admit",
  "admit-with-warning",
  "unknown",
];

const blocked = (block: CloudClefBlock): CloudClefStatus => ({
  ready: false,
  block,
  reason: CLOUD_CLEF_BLOCK_REASONS[block],
});

/** Calls a host port; a missing or throwing port answers undefined, which never admits. */
function ask(port: (() => unknown) | undefined): unknown {
  if (typeof port !== "function") return undefined;
  try {
    return port();
  } catch {
    return undefined;
  }
}

/**
 * Whether a Clef request may leave the device now, and if not, why. Settings can show the block;
 * the stage uses the same answer per turn. Checks run in a fixed order: switch, client, network,
 * credential, plan.
 */
export function cloudClefStatus(
  options: Partial<CloudClefStageOptions> | null | undefined,
): CloudClefStatus {
  if (options?.enabled !== true) return blocked("disabled");
  if (typeof options.client !== "function") return blocked("no-client");
  if (ask(options.isOnline) !== true) return blocked("offline");
  if (ask(options.hasCredential) !== true) return blocked("no-credential");
  const plan = ask(options.entitlement);
  if (!ADMITTED.includes(plan as CloudClefPlanAdmission))
    return blocked("no-plan");
  return { ready: true };
}

/**
 * Builds the chain's `clef` stage over a Cloud Clef client. Pass the result as
 * `createEndpointChain({ local, clef })`. With the switch off or no client the stage has a null
 * client and the chain leaves it out; otherwise offline, signed-out and no-plan turns are answered
 * by the gate without a request.
 */
export function createCloudClefEndpointStage(
  options: CloudClefStageOptions,
): ClefEndpointStage {
  if (
    !clefEndpointStageEnabled({
      enabled: options?.enabled,
      client: options?.client,
    })
  )
    return { enabled: false, client: null };
  const stage: ClefEndpointStage = {
    enabled: true,
    client: options.client,
    gate: () => {
      const status = cloudClefStatus(options);
      return status.ready ? null : status.reason;
    },
  };
  if (typeof options.recentTurns === "function")
    stage.recentTurns = options.recentTurns;
  if (options.timeoutMs !== undefined) stage.timeoutMs = options.timeoutMs;
  return stage;
}
