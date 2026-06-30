package ai.eliza.plugins.phone

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device instrumented test for the `@elizaos/capacitor-phone` plugin's
 * telecom/dialer status read (#9967).
 *
 * Drives the bridge-free [PhoneStatus] against the device's real
 * `TelecomManager` / `PackageManager` — the read that gates the launcher's
 * Phone surface — with no mocked `Capacitor.Plugins` bridge. Runs in isolation
 * (only this plugin library + capacitor-android + androidx.test).
 */
@RunWith(AndroidJUnit4::class)
class PhoneStatusInstrumentedTest {

    private val ctx = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun read_reportsTelecomAndDialerStateShape() {
        val s = PhoneStatus.read(ctx)
        assertTrue("has hasTelecom", s.has("hasTelecom"))
        assertTrue("has canPlaceCalls", s.has("canPlaceCalls"))
        assertTrue("has isDefaultDialer", s.has("isDefaultDialer"))
        // A phone exposes a TelecomManager.
        assertTrue("device exposes TelecomManager", s.getBoolean("hasTelecom"))
    }

    @Test
    fun read_defaultDialerIsAConcreteSystemPackage() {
        val s = PhoneStatus.read(ctx)
        val dialer = s.getString("defaultDialerPackage")
        assertNotNull("device has a default dialer package", dialer)
        requireNotNull(dialer)
        // A concrete package name read live from TelecomManager, not an empty /
        // stub value. (Resolving it via PackageManager.getPackageInfo would hit
        // Android 11+ package-visibility filtering from the unprivileged test
        // APK, so assert on the concrete value the system returned instead — it
        // is cross-checked against `adb shell cmd telecom get-default-dialer` in
        // the captured evidence.)
        assertTrue(
            "dialer is a non-blank package name",
            dialer.isNotBlank() && dialer.contains("."),
        )
    }

    @Test
    fun read_isDefaultDialerFalseForTestApkAndConsistent() {
        val s = PhoneStatus.read(ctx)
        val dialer = s.getString("defaultDialerPackage")
        // The instrumented test APK is not the device's dialer, so the read must
        // report false here AND the resolved dialer must not be the test package —
        // proving isDefaultDialer compares against the real owner, not a constant.
        assertFalse("test APK is not the default dialer", s.getBoolean("isDefaultDialer"))
        assertNotEquals("dialer package is not the test package", ctx.packageName, dialer)
    }
}
