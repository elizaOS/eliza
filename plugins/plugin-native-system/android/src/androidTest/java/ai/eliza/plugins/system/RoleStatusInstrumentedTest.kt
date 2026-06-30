package ai.eliza.plugins.system

import android.content.Intent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device instrumented test for the `@elizaos/capacitor-system` plugin's
 * launcher/comms role read (#9967).
 *
 * It runs the REAL native Kotlin ([RoleStatus.read]) against the connected
 * device's actual `RoleManager` / `TelecomManager` / `PackageManager` /
 * `Telephony` — not a mocked `Capacitor.Plugins` bridge in desktop Chromium.
 * Before this, the entire native-plugin Kotlin set ran on no instrumented test,
 * on no device; the launcher's Phone/SMS/Home/Assistant gating is exactly this
 * read, so a regression here is precisely the "dialer renders, role logic
 * broken, nothing caught it" risk the issue describes.
 *
 * Runs in isolation — only this plugin library + capacitor-android + androidx.test —
 * so it does NOT require the full app build (voice/inference JNI, fused .so).
 */
@RunWith(AndroidJUnit4::class)
class RoleStatusInstrumentedTest {

    private val targetContext =
        InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun read_reportsRealPackageNameFromContext() {
        val status = RoleStatus.read(targetContext)
        assertEquals(targetContext.packageName, status.getString("packageName"))
    }

    @Test
    fun read_enumeratesAllFourRolesFromRealRoleManager() {
        // The device runs Android 10+ (RoleManager is available), so all four
        // app-facing roles enumerate, each carrying fields read live from the
        // system: the role constant, availability, whether we hold it, holders.
        val status = RoleStatus.read(targetContext)
        val roles = status.getJSONArray("roles")
        assertNotNull("roles array present", roles)
        assertEquals("home/dialer/sms/assistant all enumerated", 4, roles.length())

        val byName = buildMap {
            for (i in 0 until roles.length()) {
                val r = roles.getJSONObject(i)
                put(r.getString("role"), r)
            }
        }
        for (name in listOf("home", "dialer", "sms", "assistant")) {
            val r = byName[name]
            assertNotNull("role '$name' present", r)
            requireNotNull(r)
            assertEquals(
                "androidRole maps to the RoleManager constant",
                RoleStatus.ROLE_MAP[name],
                r.getString("androidRole"),
            )
            assertTrue("'$name' reports availability", r.has("available"))
            assertTrue("'$name' reports held", r.has("held"))
            assertTrue("'$name' reports holders", r.has("holders"))
        }
    }

    @Test
    fun read_homeHolderMatchesTheDeviceDefaultHome() {
        // Proves the holder resolution returns REAL device data, not a stub:
        // RoleStatus' home holder must equal the package the device's own
        // PackageManager resolves as the HOME activity (the active launcher).
        val pm = targetContext.packageManager
        val homeIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
        val expectedHome = pm.resolveActivity(homeIntent, 0)?.activityInfo?.packageName
        assertNotNull("device has a default home package", expectedHome)

        val roles = RoleStatus.read(targetContext).getJSONArray("roles")
        var checked = false
        for (i in 0 until roles.length()) {
            val r = roles.getJSONObject(i)
            if (r.getString("role") != "home") continue
            if (!r.getBoolean("available")) return // role not available on this device
            val holders = r.getJSONArray("holders")
            val list = (0 until holders.length()).map { holders.getString(it) }
            assertTrue(
                "RoleStatus home holders ($list) include the real default home ($expectedHome)",
                list.contains(expectedHome),
            )
            checked = true
        }
        assertTrue("home role was present and asserted", checked)
    }
}
