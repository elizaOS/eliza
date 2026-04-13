package ai.eliza.plugins.agent

import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Eliza Agent Plugin — Android stub.
 *
 * On Android the agent runs on a server and the web implementation
 * handles all communication via HTTP. This native shell is required
 * by Capacitor's plugin system but doesn't need custom native logic.
 */
@CapacitorPlugin(name = "Agent")
class AgentPlugin : Plugin()
