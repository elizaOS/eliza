/**
 * SCHEDULING_NEGOTIATION — multi-turn scheduling-negotiation lifecycle action.
 *
 * Wave 2 W2-C extracted this surface out of the CALENDAR umbrella per
 * `docs/audit/HARDCODING_AUDIT.md` §6 #13 / §7 / §8.3 and
 * `docs/audit/IMPLEMENTATION_PLAN.md` §5.3.
 *
 * One Action, all 7 lifecycle verbs (`start`, `propose`, `respond`,
 * `finalize`, `cancel`, `list_active`, `list_proposals`). The verbs stay on
 * one stateful actor because the negotiation is a single long-running entity:
 * splitting them across separate actions would scatter the lifecycle and
 * fragment the planner's view of the negotiation record.
 *
 * The handler implementation lives next to the other scheduling helpers in
 * `./lib/scheduling-handler.ts` (with `proposeMeetingTimesAction`,
 * `checkAvailabilityAction`, `updateMeetingPreferencesAction`). This file is
 * the canonical action surface — it owns the public name and the registration
 * point — and is the one referenced from `plugin.ts` and the runtime registry.
 */

import { schedulingAction } from "./lib/scheduling-handler.js";

export const schedulingNegotiationAction = schedulingAction;
