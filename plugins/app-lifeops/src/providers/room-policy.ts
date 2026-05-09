/**
 * `roomPolicyProvider` — runs early in context assembly per
 * `GAP_ASSESSMENT.md` §3.14. If `HandoffStore.status(roomId).active`, it
 * injects "this room is in handoff mode — do not respond unless [resume
 * condition]" into the planner context.
 *
 * Combined with the planner's standard discretion, this halts agent
 * contributions cleanly until the resume condition fires.
 *
 * Position: `-9` so it lands ahead of capability providers but after the
 * `firstRunProvider` (`-10`). The first-run affordance still wins on a
 * fresh boot.
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  createHandoffStore,
  describeResumeCondition,
} from "../lifeops/handoff/store.js";

const QUIET_RESULT: ProviderResult = {
  text: "",
  values: { roomInHandoff: false },
  data: {},
};

const ONE_LINE_MAX = 240;

export const roomPolicyProvider: Provider = {
  name: "roomPolicy",
  description:
    "Per-room policy gate. Surfaces `HandoffStore` state to the planner so the agent stops contributing in rooms that are in handoff mode until the registered resume condition fires.",
  descriptionCompressed:
    "Handoff-mode gate; injects stay-quiet directive when room is handed off.",
  dynamic: true,
  position: -9,
  cacheScope: "turn",

  async get(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
    const roomId =
      typeof message.roomId === "string" && message.roomId.length > 0
        ? message.roomId
        : null;
    if (!roomId) {
      return QUIET_RESULT;
    }

    let store: ReturnType<typeof createHandoffStore>;
    try {
      store = createHandoffStore(runtime);
    } catch (error) {
      logger.debug?.(
        "[room-policy-provider] handoff store unavailable:",
        String(error),
      );
      return QUIET_RESULT;
    }

    let status: Awaited<ReturnType<typeof store.status>>;
    try {
      status = await store.status(roomId);
    } catch (error) {
      logger.debug?.(
        "[room-policy-provider] handoff status read failed:",
        String(error),
      );
      return QUIET_RESULT;
    }

    if (!status.active) {
      return QUIET_RESULT;
    }

    const resumePhrase = status.resumeOn
      ? describeResumeCondition(status.resumeOn)
      : "the resume condition fires";
    const directive =
      `This room is in handoff mode (since ${status.enteredAt ?? "earlier"}; reason: ${status.reason ?? "n/a"}). ` +
      `Do not respond unless ${resumePhrase}. Stay silent — defer to the human participants.`;
    const text = directive.slice(0, ONE_LINE_MAX);
    return {
      text,
      values: {
        roomInHandoff: true,
        handoffEnteredAt: status.enteredAt ?? "",
        handoffResumeKind: status.resumeOn?.kind ?? "",
      },
      data: {
        handoff: {
          active: true,
          enteredAt: status.enteredAt,
          reason: status.reason,
          resumeOn: status.resumeOn,
        },
      },
    };
  },
};
