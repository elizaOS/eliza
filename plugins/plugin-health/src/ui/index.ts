/** Browser-only health views and assistant-command metadata, kept off the server plugin entry. */

export {
  EMPTY_HEALTH_SNAPSHOT,
  type HealthSnapshot,
  HealthSpatialView,
  type HealthViewState,
  type StatRow as HealthStatRow,
  type WindowDays as HealthWindowDays,
} from "../components/health/HealthSpatialView.js";
export { HealthView } from "../components/health/HealthView.js";
export {
  HEALTH_ASSISTANT_COMMANDS,
  type HealthAssistantCommand,
  type HealthAssistantIconKey,
} from "./assistant-commands.js";
