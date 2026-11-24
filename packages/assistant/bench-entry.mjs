// Local benchmark entry (not committed): the agent CLI with the personal-assistant plugin bundled.
import { runAgentCli } from "@elizaos/agent/cli"
import * as assistant from "./src/index.vibe"
runAgentCli({ bundled: [{ packageName: "@elizaos/plugin-personal-assistant", plugin: assistant.default ?? assistant.plugin }] })
