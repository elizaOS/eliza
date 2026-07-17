/**
 * Curated memory hooks into validation, workspace binding, completion, and
 * respawn prompt assembly. Re-run the existing lifecycle contracts together so
 * changed-file coverage exercises the full OrchestratorTaskService integration
 * surface, rather than only the standalone memory parser.
 */

import "./admission-integration.test.js";
import "./built-apps-registry.test.js";
import "./concurrency-lifecycle-integration.test.js";
import "./orchestrator-widget-routes.test.js";
import "./parent-agent-broker-spawn.test.js";
import "./reflexion-respawn.test.js";
import "./sub-agent-completion-verification-framing.test.js";
import "./task-workdir-binding.test.js";
