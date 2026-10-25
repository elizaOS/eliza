package ai.eliza.plugins.mobilesignals

import android.app.AppOpsManager
import android.app.usage.UsageStatsManager
import android.content.Context
import android.os.Build
import android.os.Process
import java.time.Duration

/**
 * [Context]-backed reader for the `PACKAGE_USAGE_STATS` reads that
 * [MobileSignalsPlugin] exposes — the AppOps `GET_USAGE_STATS` access check, the
 * last-24h foreground-usage summary, and the idle-time computation.
 *
 * Extracted from the Capacitor plugin so the real [UsageStatsManager] /
 * [AppOpsManager] queries can be exercised by an instrumented `androidTest`,
 * without a Capacitor `Bridge`/WebView (issue #9967). The plugin delegates its
 * access check + usage summary here (single source); the reader returns plain
 * Kotlin data classes and the plugin marshals them into the unchanged JS shape.
 *
 * `PACKAGE_USAGE_STATS` is a special-access permission not grantable via a
 * runtime dialog — the test grants it host-side with
 * `appops set <pkg> android:get_usage_stats allow`.
 */
class UsageStatsReader(context: Context) {

    private val appContext: Context = context.applicationContext

    data class AppUsage(
        val packageName: String,
        val totalTimeForegroundMs: Long,
        val lastTimeUsed: Long,
    )

    data class UsageSummary(
        val totalTimeForegroundMs: Long,
        val topApps: List<AppUsage>,
    )

    /** Whether this app holds `PACKAGE_USAGE_STATS` (AppOps `GET_USAGE_STATS`). */
    fun hasUsageStatsAccess(): Boolean {
        val appOps = appContext.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            appOps.unsafeCheckOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                appContext.packageName,
            )
        } else {
            @Suppress("DEPRECATION")
            appOps.checkOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                appContext.packageName,
            )
        }
        return mode == AppOpsManager.MODE_ALLOWED
    }

    /**
     * Last-24h foreground usage: top-10 apps by foreground time + the total.
     * Empty when access is not granted (the plugin's non-throwing contract).
     */
    fun collectLastDay(now: Long = System.currentTimeMillis()): UsageSummary {
        if (!hasUsageStatsAccess()) {
            return UsageSummary(0, emptyList())
        }
        val usageStatsManager =
            appContext.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
        val stats = usageStatsManager.queryUsageStats(
            UsageStatsManager.INTERVAL_DAILY,
            now - Duration.ofDays(1).toMillis(),
            now,
        )
        val topApps = stats
            .asSequence()
            .filter { it.totalTimeInForeground > 0 }
            .sortedByDescending { it.totalTimeInForeground }
            .take(10)
            .map { AppUsage(it.packageName, it.totalTimeInForeground, it.lastTimeUsed) }
            .toList()
        return UsageSummary(stats.sumOf { it.totalTimeInForeground }, topApps)
    }

    /** Seconds since the last foreground interaction, or `null` if unavailable. */
    fun idleSeconds(now: Long = System.currentTimeMillis()): Long? {
        if (!hasUsageStatsAccess()) {
            return null
        }
        val usageStatsManager =
            appContext.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
        val stats = usageStatsManager.queryUsageStats(
            UsageStatsManager.INTERVAL_DAILY,
            now - Duration.ofDays(1).toMillis(),
            now,
        )
        val lastInteractionMs = stats.maxOfOrNull { it.lastTimeUsed } ?: 0L
        if (lastInteractionMs <= 0) {
            return null
        }
        return ((now - lastInteractionMs) / 1_000L).coerceAtLeast(0L)
    }
}
