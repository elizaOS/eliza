package ai.eliza.plugins.phone

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device instrumented test for the dialer status read (issue #9967).
 *
 * Drives the real `TelecomManager` via [PhoneStatusReader] on a device/emulator
 * and asserts the live dialer state — the native side-effect that separates a
 * working Phone view from the web stub the issue warns about.
 *
 * Run: `./gradlew :elizaos-capacitor-phone:connectedDebugAndroidTest`
 */
@RunWith(AndroidJUnit4::class)
class PhoneStatusReaderInstrumentedTest {

    private val context: Context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun readStatus_returnsRealDialerState() {
        val status = PhoneStatusReader(context).readStatus()

        // A phone-class device/emulator exposes a real TelecomManager — the read
        // is live, not the web stub's empty/false defaults.
        assertTrue("a phone device exposes a TelecomManager", status.hasTelecom)

        // isDefaultDialer is derived from the live default-dialer package.
        assertEquals(
            status.defaultDialerPackage == context.packageName,
            status.isDefaultDialer,
        )

        // The test APK is not the system default dialer.
        assertEquals(false, status.isDefaultDialer)
    }
}
