package ai.eliza.plugins.agent

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device instrumented test for the agent-service selection rule (#9967).
 *
 * Exercises [AgentServiceLocator.selectAgentServiceClass] on the device runtime —
 * the rule AgentPlugin uses to find the Service it binds the agent to (then
 * throws if absent). A mocked Capacitor bridge in Chromium never exercised it.
 */
@RunWith(AndroidJUnit4::class)
class AgentServiceLocatorInstrumentedTest {

    private fun ref(pkg: String, cls: String) = AgentServiceLocator.ServiceRef(pkg, cls)

    @Test
    fun selects_ownPackageServiceWhoseNameEndsInElizaAgentService() {
        val services = listOf(
            ref("ai.elizaos.app", "ai.elizaos.app.SomeOtherService"),
            ref("ai.elizaos.app", "ai.elizaos.app.ElizaAgentService"),
        )
        assertEquals(
            "ai.elizaos.app.ElizaAgentService",
            AgentServiceLocator.selectAgentServiceClass(services, "ai.elizaos.app"),
        )
    }

    @Test
    fun ignores_aSameNamedServiceInADifferentPackage() {
        val services = listOf(ref("com.evil.app", "com.evil.app.ElizaAgentService"))
        assertNull(AgentServiceLocator.selectAgentServiceClass(services, "ai.elizaos.app"))
    }

    @Test
    fun ignores_ownPackageServiceWithADifferentName() {
        val services = listOf(ref("ai.elizaos.app", "ai.elizaos.app.NotTheAgentService"))
        assertNull(AgentServiceLocator.selectAgentServiceClass(services, "ai.elizaos.app"))
    }

    @Test
    fun returnsNull_whenThereAreNoServices_soThePluginThrows() {
        assertNull(AgentServiceLocator.selectAgentServiceClass(emptyList(), "ai.elizaos.app"))
    }
}
