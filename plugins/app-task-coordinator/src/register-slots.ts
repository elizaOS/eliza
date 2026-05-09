/**
 * Side-effect module that registers task-coordinator React components
 * with app-core's slot registry at import time.
 *
 * The root app imports this from its main entry
 * (`import "@elizaos/app-task-coordinator/register-slots";`) so that
 * app-core's slot wrappers — CodingAgentSettingsSection, PtyConsoleBase,
 * CodingAgentTasksPanel, CodingAgentControlChip — render the real
 * components. Without this import they render as `null` placeholders.
 *
 * This keeps app-core → app-task-coordinator off the static import graph
 * (app-core depends only on its own slot registry) while still letting
 * task-coordinator depend on app-core for hooks, types, and the client.
 */

import { registerTaskCoordinatorSlots } from "@elizaos/ui";
import { CodingAgentControlChip } from "./CodingAgentControlChip.js";
import { CodingAgentSettingsSection } from "./CodingAgentSettingsSection.js";
import { CodingAgentTasksPanel } from "./CodingAgentTasksPanel.js";
import { PtyConsoleBase } from "./PtyConsoleBase.js";

registerTaskCoordinatorSlots({
  CodingAgentControlChip,
  CodingAgentSettingsSection,
  CodingAgentTasksPanel,
  PtyConsoleBase,
});
