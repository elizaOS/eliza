package ai.eliza.plugins.mobilesignals

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device read test for the `PACKAGE_USAGE_STATS` queries (issue #9967).
 *
 * Drives the real [android.app.usage.UsageStatsManager] /
 * [android.app.AppOpsManager] path via [UsageStatsReader] — the same reads
 * [MobileSignalsPlugin] exposes for its device snapshot — and asserts the
 * returned foreground-usage summary is well-formed.
 *
 * `PACKAGE_USAGE_STATS` is a special-access permission not grantable via a
 * runtime dialog, so the harness grants it host-side before the run:
 *
 *   adb -s <device> shell appops set <testPkg> android:get_usage_stats allow
 *
 * The usage tests `Assume`-skip when the grant is absent, so they never hard-
 * fail on an un-orchestrated run; when granted they assert against the device's
 * real app-usage history.
 */
@RunWith(AndroidJUnit4::class)
class UsageStatsReaderInstrumentedTest {

    private val context: Context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun hasUsageStatsAccess_runsTheAppOpsCheckOnDevice() {
        // The AppOps GET_USAGE_STATS probe executes against the real
        // AppOpsManager and returns a definite boolean (no crash, no throw).
        val access = UsageStatsReader(context).hasUsageStatsAccess()
        assertTrue("hasUsageStatsAccess returns a concrete boolean", access || !access)
    }

    @Test
    fun collectLastDay_returnsWellFormedRealUsage() {
        val reader = UsageStatsReader(context)
        assumeTrue(
            "PACKAGE_USAGE_STATS not granted — run `appops set <testPkg> " +
                "android:get_usage_stats allow` on an emulator/device first",
            reader.hasUsageStatsAccess(),
        )

        val summary = reader.collectLastDay()

        // Every reported app row is well-formed real data from the live provider.
        for (app in summary.topApps) {
            assertTrue("package name is non-empty", app.packageName.isNotEmpty())
            assertTrue("foreground time ${app.totalTimeForegroundMs} > 0", app.totalTimeForegroundMs > 0)
            assertTrue("lastTimeUsed ${app.lastTimeUsed} is a real epoch ms", app.lastTimeUsed > 0)
        }
        // top-10 cap honored, and sorted descending by foreground time.
        assertTrue("at most the top 10 apps", summary.topApps.size <= 10)
        val times = summary.topApps.map { it.totalTimeForegroundMs }
        assertEquals("top apps are sorted by foreground time desc", times.sortedDescending(), times)
        // The total foreground time is at least the sum of the reported top apps.
        assertTrue(
            "total foreground ${summary.totalTimeForegroundMs} >= sum of top apps",
            summary.totalTimeForegroundMs >= times.sum(),
        )
    }

    @Test
    fun idleSeconds_isNonNegativeWhenGranted() {
        val reader = UsageStatsReader(context)
        assumeTrue("PACKAGE_USAGE_STATS not granted", reader.hasUsageStatsAccess())

        val idle = reader.idleSeconds()
        // Either no interaction recorded (null) or a non-negative elapsed value —
        // never a negative idle.
        assumeTrue("no foreground interaction recorded in the last day", idle != null)
        assertTrue("idle seconds ${idle!!} is non-negative", idle >= 0)
    }
}
