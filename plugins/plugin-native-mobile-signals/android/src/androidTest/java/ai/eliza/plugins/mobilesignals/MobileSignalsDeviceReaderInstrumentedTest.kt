package ai.eliza.plugins.mobilesignals

import android.app.AppOpsManager
import android.content.Context
import android.os.Build
import android.os.Process
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MobileSignalsDeviceReaderInstrumentedTest {
    private val context: Context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun snapshotReadsNativeDeviceState() {
        val snapshot = MobileSignalsDeviceReader(context).buildSnapshot("androidTest")
        val metadata = snapshot.getJSONObject("metadata")
        val screenTime = metadata.getJSONObject("screenTime")

        assertEquals("mobile_device", snapshot.getString("source"))
        assertEquals("android", snapshot.getString("platform"))
        assertTrue(snapshot.getLong("observedAt") > 0)
        assertTrue(setOf("active", "background", "idle", "locked").contains(snapshot.getString("state")))
        assertTrue(setOf("active", "idle", "locked").contains(snapshot.getString("idleState")))
        assertEquals("androidTest", metadata.getString("reason"))
        assertNotNull(metadata.get("isInteractive"))
        assertNotNull(metadata.get("isDeviceLocked"))
        assertNotNull(metadata.get("isPowerSaveMode"))
        assertNotNull(metadata.get("isCharging"))
        assertTrue(screenTime.getBoolean("permissionDeclared"))
        assertEquals(24, screenTime.getInt("windowHours"))
    }

    @Test
    fun usageAccessStatusMatchesAppOps() {
        val reader = MobileSignalsDeviceReader(context)
        val expected = appOpsUsageAccessAllowed()
        val status = reader.buildScreenTimeStatus()
        val androidStatus = status.getJSONObject("android")

        assertEquals(expected, reader.hasUsageStatsAccess())
        assertEquals(expected, androidStatus.getBoolean("usageAccessGranted"))
        assertEquals(expected, status.getBoolean("reportAvailable"))
        assertEquals(expected, status.getBoolean("coarseSummaryAvailable"))
        assertTrue(androidStatus.getBoolean("packageUsageStatsPermissionDeclared"))
    }

    @Test
    fun usageSummaryIsBoundedWhenAccessIsGranted() {
        val reader = MobileSignalsDeviceReader(context)
        val summary = reader.collectUsageStatsSummary()

        if (reader.hasUsageStatsAccess()) {
            assertTrue(summary.totalTimeForegroundMs >= 0)
            assertTrue(summary.topApps.size <= 10)
        } else {
            assertEquals(0, summary.totalTimeForegroundMs)
            assertTrue(summary.topApps.isEmpty())
        }
    }

    @Test
    fun showcaseActivityRendersReaderOutput() {
        ActivityScenario.launch(MobileSignalsReaderShowcaseActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                assertTrue(activity.snapshotText().contains("Mobile Signals Reader"))
                assertTrue(activity.snapshotText().contains("Usage access:"))
            }
        }
    }

    private fun appOpsUsageAccessAllowed(): Boolean {
        val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            appOps.unsafeCheckOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                context.packageName,
            )
        } else {
            @Suppress("DEPRECATION")
            appOps.checkOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                context.packageName,
            )
        }
        return mode == AppOpsManager.MODE_ALLOWED
    }
}
