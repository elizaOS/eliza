// TODO: validate on device — checklist in ANDROID_CONSTRAINTS.md
//
// UsageStatsHelper — wraps UsageStatsManager for app enumeration.
//
// Requires PACKAGE_USAGE_STATS permission (AppOps special — user must grant in
// Settings > Digital Wellbeing > or Settings > Security > Usage Access).
// There is no runtime-permission prompt dialog for this; direct the user to
// Settings programmatically via:
//   startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS))
//
// MARK: - Contract (mirrors android-bridge.ts enumerateApps)
//
// enumerateApps() → AppUsageEntry[]
//   [{ packageName, label, lastUsedMs, totalForegroundMs, isForeground }]

package ai.elizaos.computeruse

import android.app.AppOpsManager
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Process
import org.json.JSONArray
import org.json.JSONObject

object UsageStatsHelper {

    data class AppUsageEntry(
        val packageName: String,
        val label: String,
        val lastUsedMs: Long,
        val totalForegroundMs: Long,
        val isForeground: Boolean,
    )

    /**
     * Returns true if PACKAGE_USAGE_STATS has been granted via AppOps.
     * The permission is not a runtime permission — it must be granted manually
     * in Settings. This check is used to surface an actionable error to JS.
     */
    fun hasUsageStatsPermission(context: Context): Boolean {
        val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            appOps.unsafeCheckOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                context.packageName
            )
        } else {
            @Suppress("DEPRECATION")
            appOps.checkOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                context.packageName
            )
        }
        return mode == AppOpsManager.MODE_ALLOWED
    }

    /**
     * Query usage stats for the past 24 hours and build the app list.
     * Blocks — call from a background thread (the Capacitor plugin dispatches
     * to a background executor before calling this).
     *
     * Returns an empty list (not an exception) when no data is available so
     * the JS layer can distinguish "permission denied" (throws) from
     * "no recent usage" (empty list).
     */
    fun enumerateApps(context: Context): List<AppUsageEntry> {
        if (!hasUsageStatsPermission(context)) {
            throw SecurityException(
                "PACKAGE_USAGE_STATS not granted — user must enable in Settings > Usage Access"
            )
        }

        val usm = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
        val now = System.currentTimeMillis()
        val oneDayMs = 24 * 60 * 60 * 1000L
        val stats = usm.queryAndAggregateUsageStats(now - oneDayMs, now)

        // Determine the foreground app via queryEvents for the last 5 minutes.
        val foregroundPackage = resolveForegroundPackage(usm, now)

        val pm = context.packageManager
        return stats.values.map { stat ->
            val label = try {
                pm.getApplicationLabel(
                    pm.getApplicationInfo(stat.packageName, 0)
                ).toString()
            } catch (_: PackageManager.NameNotFoundException) {
                stat.packageName
            }
            AppUsageEntry(
                packageName = stat.packageName,
                label = label,
                lastUsedMs = stat.lastTimeUsed,
                totalForegroundMs = stat.totalTimeInForeground,
                isForeground = stat.packageName == foregroundPackage,
            )
        }.sortedByDescending { it.lastUsedMs }
    }

    /** Best-effort: scan recent events for the latest MOVE_TO_FOREGROUND entry. */
    private fun resolveForegroundPackage(usm: UsageStatsManager, now: Long): String? {
        val events = usm.queryEvents(now - 5 * 60 * 1000L, now) ?: return null
        val event = android.app.usage.UsageEvents.Event()
        var last: String? = null
        while (events.hasNextEvent()) {
            events.getNextEvent(event)
            if (event.eventType == android.app.usage.UsageEvents.Event.MOVE_TO_FOREGROUND) {
                last = event.packageName
            }
        }
        return last
    }

    /** Serialize to JSON matching the JS AppUsageEntry shape. */
    fun toJson(entries: List<AppUsageEntry>): String {
        val arr = JSONArray()
        for (e in entries) {
            arr.put(JSONObject().apply {
                put("packageName", e.packageName)
                put("label", e.label)
                put("lastUsedMs", e.lastUsedMs)
                put("totalForegroundMs", e.totalForegroundMs)
                put("isForeground", e.isForeground)
            })
        }
        return arr.toString()
    }
}
