/**
 * Verifies that the musl Android agent delegates every fused bionic inference
 * build through the JNI host, independently of optional accelerator backends.
 */
package ai.elizaos.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class BionicHostDelegationPolicyTest {

    @Test
    public void fusedCpuBuildDelegatesWhenJniBridgeIsPresent() {
        assertTrue(ElizaAgentService.shouldDelegateFusedInference(true, true));
    }

    @Test
    public void missingFusedLibraryOrBridgeCannotAdvertiseDelegation() {
        assertFalse(ElizaAgentService.shouldDelegateFusedInference(false, true));
        assertFalse(ElizaAgentService.shouldDelegateFusedInference(true, false));
        assertFalse(ElizaAgentService.shouldDelegateFusedInference(false, false));
    }
}
