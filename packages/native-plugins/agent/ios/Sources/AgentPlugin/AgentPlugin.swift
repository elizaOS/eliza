import Capacitor

/// Eliza Agent Plugin — iOS stub.
///
/// On iOS the agent runs on a server and the web implementation
/// handles all communication via HTTP. This native shell is required
/// by Capacitor's plugin system but doesn't need custom native logic.
@objc(AgentPlugin)
public class AgentPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AgentPlugin"
    public let jsName = "Agent"
    public let pluginMethods: [CAPPluginMethod] = []
}
