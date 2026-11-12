package ai.eliza.plugins.mobilesignals

import android.app.AppOpsManager
import android.app.usage.UsageEvents
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
        /** Time of the newest foreground or background event, or `null` when none. */
        val lastEventAt: Long? = null,
    ) {
        /** Seconds since [lastEventAt], or `null` if no event was recorded. */
        fun idleSeconds(now: Long): Long? {
            val last = lastEventAt ?: return null
            return ((now - last) / 1_000L).coerceAtLeast(0L)
        }
    }

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
     *
     * Built from the raw foreground/background events over the exact window,
     * merged by package. `queryUsageStats(INTERVAL_DAILY, ...)` returns one row
     * per package per daily bucket, so a 24 h window that spans two buckets
     * listed apps twice and counted most of the previous day as well.
     */
    fun collectLastDay(now: Long = System.currentTimeMillis()): UsageSummary {
        if (!hasUsageStatsAccess()) {
            return UsageSummary(0, emptyList())
        }
        val windowStart = now - WINDOW_MS
        val usageStatsManager =
            appContext.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
        val events = usageStatsManager.queryEvents(windowStart, now)
        val event = UsageEvents.Event()
        // Resumed activities per package, and when the package came to the front.
        val resumed = mutableMapOf<String, MutableSet<String>>()
        val since = mutableMapOf<String, Long>()
        val seen = mutableSetOf<String>()
        val foregroundMs = mutableMapOf<String, Long>()
        val lastUsed = mutableMapOf<String, Long>()
        var lastEventAt: Long? = null

        fun close(pkg: String, at: Long) {
            val from = since.remove(pkg) ?: return
            foregroundMs[pkg] = (foregroundMs[pkg] ?: 0L) + (at - from).coerceAtLeast(0L)
        }

        while (events.hasNextEvent()) {
            events.getNextEvent(event)
            val pkg = event.packageName ?: continue
            val at = event.timeStamp.coerceIn(windowStart, now)
            when (event.eventType) {
                @Suppress("DEPRECATION") UsageEvents.Event.MOVE_TO_FOREGROUND -> {
                    val activities = resumed.getOrPut(pkg) { mutableSetOf() }
                    if (activities.isEmpty()) since[pkg] = at
                    activities.add(event.className ?: "")
                    seen.add(pkg)
                    lastUsed[pkg] = at
                    lastEventAt = at
                }
                @Suppress("DEPRECATION") UsageEvents.Event.MOVE_TO_BACKGROUND -> {
                    val activities = resumed[pkg]
                    if (activities.isNullOrEmpty()) {
                        // The app was already in front when the window opened.
                        if (pkg !in seen) {
                            foregroundMs[pkg] = (foregroundMs[pkg] ?: 0L) + (at - windowStart)
                        }
                    } else {
                        activities.remove(event.className ?: "")
                        if (activities.isEmpty()) close(pkg, at)
                    }
                    seen.add(pkg)
                    lastUsed[pkg] = at
                    lastEventAt = at
                }
                UsageEvents.Event.DEVICE_SHUTDOWN, UsageEvents.Event.DEVICE_STARTUP -> {
                    // No background events are written across a reboot.
                    for (open in since.keys.toList()) close(open, at)
                    resumed.clear()
                }
            }
        }
        for (open in since.keys.toList()) close(open, now)

        val merged = foregroundMs.filterValues { it > 0 }
        val topApps = merged.entries
            .sortedByDescending { it.value }
            .take(10)
            .map { AppUsage(it.key, it.value, lastUsed[it.key] ?: now) }
        // Split screen can keep two packages in front at once; the summary
        // still describes a 24 h window.
        val total = merged.values.sum().coerceAtMost(WINDOW_MS)
        return UsageSummary(total, topApps, lastEventAt)
    }

    /** Seconds since the last foreground interaction, or `null` if unavailable. */
    fun idleSeconds(now: Long = System.currentTimeMillis()): Long? {
        if (!hasUsageStatsAccess()) {
            return null
        }
        return collectLastDay(now).idleSeconds(now)
    }

    companion object {
        val WINDOW_MS: Long = Duration.ofDays(1).toMillis()
    }
}
