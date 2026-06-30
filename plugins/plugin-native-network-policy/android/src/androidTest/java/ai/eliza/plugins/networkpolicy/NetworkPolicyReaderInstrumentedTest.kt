package ai.eliza.plugins.networkpolicy

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device instrumented test for `@elizaos/capacitor-network-policy`'s metered
 * hint read (#9967) — the signal the voice-model auto-updater gates downloads on.
 *
 * Drives the bridge-free [NetworkPolicyReader] against the device's real
 * `ConnectivityManager` and checks it against an independent live read of the
 * active network's capabilities — not a mocked Capacitor bridge.
 */
@RunWith(AndroidJUnit4::class)
class NetworkPolicyReaderInstrumentedTest {

    private val ctx = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun readMeteredHint_reflectsTheRealActiveNetworkCapability() {
        val result = NetworkPolicyReader.readMeteredHint(ctx)
        assertEquals("android-os", result.getString("source"))
        assertTrue("always reports a metered field", result.has("metered"))

        val cm = ctx.applicationContext
            .getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val active = cm.activeNetwork
        val caps = active?.let { cm.getNetworkCapabilities(it) }
        if (caps != null) {
            // metered must be the inverse of the live NOT_METERED capability —
            // the exact derivation the updater consumes, computed on real state.
            val expectedMetered =
                !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
            assertEquals(
                "metered matches the live NetworkCapabilities",
                expectedMetered,
                result.getBoolean("metered"),
            )
        } else {
            // No active network / capabilities → the read must surface null, not
            // a guessed default.
            assertTrue("no active network → metered is null", result.isNull("metered"))
        }
    }

    @Test
    fun readPathHints_returnsTheAndroidNoInfoShape() {
        val result = NetworkPolicyReader.readPathHints()
        assertEquals(false, result.getBoolean("isExpensive"))
        assertEquals(false, result.getBoolean("isConstrained"))
        assertEquals("nw-path-monitor", result.getString("source"))
    }
}
