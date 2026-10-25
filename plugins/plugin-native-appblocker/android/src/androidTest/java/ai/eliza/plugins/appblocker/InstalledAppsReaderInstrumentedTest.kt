package ai.eliza.plugins.appblocker

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device read test for the launchable-app enumeration (issue #9967).
 *
 * Drives the real [android.content.pm.PackageManager] query via
 * [InstalledAppsReader] — the same read [AppBlockerPlugin.getInstalledApps]
 * exposes — and asserts the result is real, well-formed, de-duplicated, and
 * sorted. Permission-free, so it asserts positively on any device/emulator.
 */
@RunWith(AndroidJUnit4::class)
class InstalledAppsReaderInstrumentedTest {

    private val context: Context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun listLaunchableApps_returnsRealWellFormedApps() {
        val apps = InstalledAppsReader(context).listLaunchableApps()

        // Every Android device/emulator ships launchable system apps.
        assertTrue("device has at least one launchable app", apps.isNotEmpty())

        for (app in apps) {
            assertTrue("package name is non-empty", app.packageName.isNotEmpty())
            assertTrue("display name is non-empty for ${app.packageName}", app.displayName.isNotEmpty())
        }

        // De-duplicated by package name.
        assertEquals(
            "no duplicate packages",
            apps.map { it.packageName }.distinct().size,
            apps.size,
        )

        // Sorted case-insensitively by display name (the plugin's contract).
        val names = apps.map { it.displayName.lowercase() }
        assertEquals("sorted by display name", names.sortedBy { it }, names)
    }

    @Test
    fun listLaunchableApps_includesAKnownLauncherApp() {
        val apps = InstalledAppsReader(context).listLaunchableApps()
        // The Settings app is launchable on every standard Android image — a
        // concrete cross-check that the real PackageManager query ran (not a stub).
        assertTrue(
            "a known launchable system app (Settings or a launcher) is present",
            apps.any {
                it.packageName == "com.android.settings" ||
                    it.packageName.contains("launcher")
            },
        )
    }
}
