package ai.eliza.plugins.agent

/**
 * Pure selection of the on-device agent Service class (#9967).
 *
 * Extracted out of [AgentPlugin] so the rule that picks the agent service — our
 * **own** package's manifest service whose name ends in `.ElizaAgentService` —
 * can be exercised by an instrumented test without the service being installed.
 * Constraining the match to the caller's own package is what stops a same-named
 * service in a different app from being picked; [AgentPlugin] builds the
 * manifest service list and delegates here (throwing when nothing matches).
 */
object AgentServiceLocator {
    data class ServiceRef(val packageName: String, val className: String)

    fun selectAgentServiceClass(services: List<ServiceRef>, ownPackage: String): String? =
        services.firstOrNull {
            it.packageName == ownPackage && it.className.endsWith(".ElizaAgentService")
        }?.className
}
