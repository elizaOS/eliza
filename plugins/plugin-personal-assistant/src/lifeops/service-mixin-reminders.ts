/**
 * Reminders service mixin: re-exports the reminder domain surface and dispatch
 * prompt and composes the reminder domain's firing methods onto the
 * LifeOpsService base.
 */
export type { LifeOpsReminderService } from "./domains/reminders-service.js";
export { buildReminderDispatchPrompt } from "./domains/reminders-service.js";
export { REMINDER_DISPATCH_INSTRUCTIONS } from "./optimized-prompt-instructions.js";
