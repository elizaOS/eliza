package ai.elizaos.plugins.bunruntime

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device instrumented test for the agent-service selection rule (#9967).
 *
 * Exercises [AgentServiceLocator.selectAgentServiceClass] on the device runtime —
 * the rule that decides which manifest Service the bun runtime binds the local
 * agent to. A mocked Capacitor bridge in Chromium never exercised it.
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
        // The package guard is the security property: another app declaring an
        // ".ElizaAgentService" must NOT be selected.
        val services = listOf(ref("com.evil.app", "com.evil.app.ElizaAgentService"))
        assertNull(AgentServiceLocator.selectAgentServiceClass(services, "ai.elizaos.app"))
    }

    @Test
    fun ignores_ownPackageServiceWithADifferentName() {
        val services = listOf(ref("ai.elizaos.app", "ai.elizaos.app.NotTheAgentService"))
        assertNull(AgentServiceLocator.selectAgentServiceClass(services, "ai.elizaos.app"))
    }

    @Test
    fun returnsNull_whenThereAreNoServices() {
        assertNull(AgentServiceLocator.selectAgentServiceClass(emptyList(), "ai.elizaos.app"))
    }
}
