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
import { confirmMeetingAction } from "./src/actions/confirm-meeting.js";
import { scheduleMeetingAction } from "./src/actions/schedule-meeting.js";
import { setAvailabilityAction } from "./src/actions/set-availability.js";
import { schedulingContextProvider } from "./src/providers/scheduling-context.js";
import { SchedulingService } from "./src/services/scheduling-service.js";

export * from "./src/services/scheduling-service.js";
export * from "./src/storage.js";
export * from "./src/types.js";
export * from "./src/utils/ical.js";

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
