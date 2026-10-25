/** Verifies renderer-epoch fencing without an Android runtime. */
package ai.eliza.plugins.browsersurface

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ActiveOwnerRegistryTest {
    @Test
    fun newerEpochPermanentlyRetiresDelayedCommandsFromTheOldRealm() {
        val registry = ActiveOwnerRegistry()
        val old = NativeOwnerIdentity("browser", "realm-old", 10L)
        val current = NativeOwnerIdentity("browser", "realm-current", 11L)

        assertTrue(registry.claim(old))
        assertTrue(registry.isActive(old))
        assertTrue(registry.claim(current))
        assertFalse(registry.isActive(old))
        assertTrue(registry.isActive(current))
        assertFalse(registry.claim(old))
        assertFalse(registry.isActive(old))
    }

    @Test
    fun equalEpochCannotBeClaimedByADifferentSession() {
        val registry = ActiveOwnerRegistry()
        val current = NativeOwnerIdentity("browser", "realm-a", 20L)
        val collision = NativeOwnerIdentity("browser", "realm-b", 20L)

        assertTrue(registry.claim(current))
        assertFalse(registry.claim(collision))
        assertTrue(registry.isActive(current))
        assertFalse(registry.isActive(collision))
    }

    @Test
    fun isolatedRendererRequiresApiFeatureAndLiveOutOfAppHandle() {
        assertFalse(supportsIsolatedRenderer(25, true, true))
        assertFalse(supportsIsolatedRenderer(26, false, true))
        assertFalse(supportsIsolatedRenderer(26, true, false))
        assertTrue(supportsIsolatedRenderer(26, true, true))
    }

    @Test
    fun isolatedStorageRequiresAndroidxMultiProfileSupport() {
        assertFalse(supportsIsolatedStorage(false))
        assertTrue(supportsIsolatedStorage(true))
    }
}
