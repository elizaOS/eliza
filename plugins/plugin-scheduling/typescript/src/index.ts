/**
 * @module plugin-scheduling
 * @description ElizaOS plugin for scheduling and calendar coordination
 *
 * This plugin provides:
 * - Multi-party availability coordination
 * - Meeting scheduling with time slot proposals
 * - Calendar invite generation (ICS format)
 * - Automated reminders
 * - Rescheduling and cancellation handling
 *
 * Key features:
 * - Time zone aware scheduling
 * - Preference-based slot scoring
 * - Integration with form plugin for conversational scheduling
 */

import type { Plugin } from "@elizaos/core";
import { confirmMeetingAction } from "./actions/confirm-meeting.js";
import { scheduleMeetingAction } from "./actions/schedule-meeting.js";
import { setAvailabilityAction } from "./actions/set-availability.js";
import { schedulingContextProvider } from "./providers/scheduling-context.js";
import { SchedulingService } from "./services/scheduling-service.js";

export * from "./services/scheduling-service.js";
export * from "./storage.js";
export * from "./types.js";
export * from "./utils/ical.js";

/**
 * Scheduling plugin for ElizaOS
 *
 * Provides scheduling capabilities for coordinating meetings
 * between multiple participants.
 *
 * Usage:
 * ```typescript
 * import { schedulingPlugin } from '@elizaos/plugin-scheduling';
 *
 * const character = createCharacter({
 *   name: 'Scheduler',
 *   plugins: [schedulingPlugin],
 * });
 * ```
 */
export const schedulingPlugin: Plugin = {
  name: "scheduling",
  description: "Scheduling and calendar coordination for multi-party meetings",

  // Register the scheduling service
  services: [SchedulingService],

  // Actions for scheduling operations
  actions: [scheduleMeetingAction, confirmMeetingAction, setAvailabilityAction],

  // Provider for scheduling context
  providers: [schedulingContextProvider],
};

export default schedulingPlugin;
