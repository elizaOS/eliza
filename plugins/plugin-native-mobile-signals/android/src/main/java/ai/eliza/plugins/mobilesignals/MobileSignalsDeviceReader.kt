package ai.eliza.plugins.mobilesignals

import android.app.AppOpsManager
import android.app.KeyguardManager
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.os.Process
import android.provider.Settings
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import java.time.Duration
import org.json.JSONObject

internal const val PACKAGE_USAGE_STATS_PERMISSION = "android.permission.PACKAGE_USAGE_STATS"
private const val FAMILY_CONTROLS_ENTITLEMENT = "com.apple.developer.family-controls"

internal class MobileSignalsDeviceReader(private val context: Context) {
    fun buildSnapshot(reason: String): JSObject {
        val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        val keyguardManager = context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))

        val interactive = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT_WATCH) {
            powerManager.isInteractive
        } else {
            @Suppress("DEPRECATION")
            powerManager.isScreenOn
        }
        val locked = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            keyguardManager.isDeviceLocked
        } else {
            @Suppress("DEPRECATION")
            keyguardManager.isKeyguardLocked
        }
        val powerSaveMode = powerManager.isPowerSaveMode
        val deviceIdle = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            powerManager.isDeviceIdleMode
        } else {
            false
        }
        val state = when {
            locked -> "locked"
            !interactive -> "background"
            powerSaveMode || deviceIdle -> "idle"
            else -> "active"
        }
        val idleState = when {
            locked -> "locked"
            !interactive || powerSaveMode || deviceIdle -> "idle"
            else -> "active"
        }
        val batteryLevel = battery?.let {
            val level = it.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
            val scale = it.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
            if (level >= 0 && scale > 0) {
                level.toDouble() / scale.toDouble()
            } else {
                null
            }
        }
        val plugged = battery?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
        val isCharging = battery?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) in setOf(
            BatteryManager.BATTERY_STATUS_CHARGING,
            BatteryManager.BATTERY_STATUS_FULL,
        )
        val idleTimeSeconds = computeIdleTimeSeconds(locked, interactive)

        return JSObject().apply {
            put("source", "mobile_device")
            put("platform", "android")
            put("state", state)
            put("observedAt", System.currentTimeMillis())
            put("idleState", idleState)
            put("idleTimeSeconds", idleTimeSeconds ?: JSONObject.NULL)
            put("onBattery", plugged == 0)
            put("metadata", JSObject().apply {
                put("reason", reason)
                put("isInteractive", interactive)
                put("isDeviceLocked", locked)
                put("isPowerSaveMode", powerSaveMode)
                put("isDeviceIdleMode", deviceIdle)
                put("isCharging", isCharging)
                put("batteryLevel", batteryLevel)
                put("screenTime", buildUsageStatsSummary())
            })
        }
    }

    fun buildScreenTimeStatus(
        reason: String = "Android Usage Access is required for app foreground-time summaries.",
    ): JSObject {
        val usageGranted = hasUsageStatsAccess()
        val totalTimeForegroundMs = if (usageGranted) {
            collectUsageStatsSummary().totalTimeForegroundMs
        } else {
            null
        }
        val status = if (usageGranted) "approved" else "not-determined"
        val resolvedReason = if (usageGranted) null else reason
        return JSObject().apply {
            put("supported", true)
            put("requirements", JSObject().apply {
                put("entitlements", JSObject().apply {
                    put("familyControls", FAMILY_CONTROLS_ENTITLEMENT)
                })
                put("frameworks", listOf("FamilyControls", "DeviceActivity"))
                put("deviceActivityReportExtension", false)
                put("deviceActivityMonitorExtension", false)
                put("android", JSObject().apply {
                    put("usageStatsPermission", PACKAGE_USAGE_STATS_PERMISSION)
                    put("usageAccessSettingsAction", Settings.ACTION_USAGE_ACCESS_SETTINGS)
                })
            })
            put("entitlements", JSObject().apply {
                put("familyControls", false)
            })
            put("provisioning", JSObject().apply {
                put("satisfied", usageGranted)
                put("inspected", "not-inspectable")
                put("reason", resolvedReason ?: JSONObject.NULL)
            })
            put("authorization", JSObject().apply {
                put("status", status)
                put("canRequest", false)
            })
            put("reportAvailable", usageGranted)
            put("coarseSummaryAvailable", usageGranted)
            put("thresholdEventsAvailable", false)
            put("rawUsageExportAvailable", false)
            put("android", JSObject().apply {
                put("usageAccessGranted", usageGranted)
                put("packageUsageStatsPermissionDeclared", isUsageStatsPermissionDeclared())
                put("canOpenUsageAccessSettings", true)
                put("foregroundEventsAvailable", usageGranted)
                put("totalTimeForegroundMs", totalTimeForegroundMs ?: JSONObject.NULL)
            })
            put("reason", resolvedReason ?: JSONObject.NULL)
        }
    }

    fun hasUsageStatsAccess(): Boolean {
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

    fun isUsageStatsPermissionDeclared(): Boolean {
        return try {
            val packageInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                context.packageManager.getPackageInfo(
                    context.packageName,
                    PackageManager.PackageInfoFlags.of(PackageManager.GET_PERMISSIONS.toLong()),
                )
            } else {
                @Suppress("DEPRECATION")
                context.packageManager.getPackageInfo(
                    context.packageName,
                    PackageManager.GET_PERMISSIONS,
                )
            }
            packageInfo.requestedPermissions?.contains(PACKAGE_USAGE_STATS_PERMISSION) == true
        } catch (_: PackageManager.NameNotFoundException) {
            false
        }
    }

    fun collectUsageStatsSummary(): UsageStatsSummary {
        if (!hasUsageStatsAccess()) {
            return UsageStatsSummary(0, emptyList())
        }
        val usageStatsManager =
            context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
        val nowMs = System.currentTimeMillis()
        val stats = usageStatsManager.queryUsageStats(
            UsageStatsManager.INTERVAL_DAILY,
            nowMs - Duration.ofDays(1).toMillis(),
            nowMs,
        )
        val topApps = stats
            .asSequence()
            .filter { it.totalTimeInForeground > 0 }
            .sortedByDescending { it.totalTimeInForeground }
            .take(10)
            .map { usage ->
                UsageAppSummary(
                    packageName = usage.packageName,
                    totalTimeForegroundMs = usage.totalTimeInForeground,
                    lastTimeUsed = usage.lastTimeUsed,
                )
            }
            .toList()
        val totalTimeForegroundMs = stats.sumOf { it.totalTimeInForeground }
        return UsageStatsSummary(totalTimeForegroundMs, topApps)
    }

    fun buildUsageStatsSummary(): JSObject {
        val granted = hasUsageStatsAccess()
        val summary = if (granted) {
            collectUsageStatsSummary()
        } else {
            UsageStatsSummary(0, emptyList())
        }
        return JSObject().apply {
            put("granted", granted)
            put("permissionDeclared", isUsageStatsPermissionDeclared())
            put("windowHours", 24)
            put("totalTimeForegroundMs", if (granted) summary.totalTimeForegroundMs else JSONObject.NULL)
            put(
                "topApps",
                JSArray(summary.topApps.map { app ->
                    JSObject().apply {
                        put("packageName", app.packageName)
                        put("totalTimeForegroundMs", app.totalTimeForegroundMs)
                        put("lastTimeUsed", app.lastTimeUsed)
                    }
                }),
            )
        }
    }

    private fun computeIdleTimeSeconds(locked: Boolean, interactive: Boolean): Long? {
        if (!hasUsageStatsAccess()) {
            return null
        }
        val lastInteractionMs = try {
            val usageStatsManager =
                context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
            val nowMs = System.currentTimeMillis()
            val stats = usageStatsManager.queryUsageStats(
                UsageStatsManager.INTERVAL_DAILY,
                nowMs - Duration.ofDays(1).toMillis(),
                nowMs,
            )
            stats.maxOfOrNull { it.lastTimeUsed } ?: 0L
        } catch (_: Throwable) {
            return null
        }
        if (lastInteractionMs <= 0) {
            return null
        }
        val nowMs = System.currentTimeMillis()
        val elapsedSeconds = ((nowMs - lastInteractionMs) / 1_000L).coerceAtLeast(0L)
        return if (locked || !interactive) {
            elapsedSeconds
        } else {
            elapsedSeconds
        }
    }
}

internal data class UsageStatsSummary(
    val totalTimeForegroundMs: Long,
    val topApps: List<UsageAppSummary>,
)

internal data class UsageAppSummary(
    val packageName: String,
    val totalTimeForegroundMs: Long,
    val lastTimeUsed: Long,
)
