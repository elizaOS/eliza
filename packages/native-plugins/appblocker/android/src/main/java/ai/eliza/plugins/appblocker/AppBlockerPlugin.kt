package ai.eliza.plugins.appblocker

import android.app.AppOpsManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.ContextCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.time.Instant

@CapacitorPlugin(name = "ElizaAppBlocker")
class AppBlockerPlugin : Plugin() {

    @PluginMethod
    override fun checkPermissions(call: PluginCall) {
        call.resolve(buildPermissionResult())
    }

    @PluginMethod
    override fun requestPermissions(call: PluginCall) {
        when {
            !hasUsageAccess() -> openSettings(Settings.ACTION_USAGE_ACCESS_SETTINGS, null)
            !canDrawOverlays() -> openSettings(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:${context.packageName}"),
            )
        }
        call.resolve(buildPermissionResult())
    }

    @PluginMethod
    fun getInstalledApps(call: PluginCall) {
        val launcherIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            PackageManager.ResolveInfoFlags.of(0)
        } else {
            null
        }
        val matches = if (flags != null) {
            context.packageManager.queryIntentActivities(launcherIntent, flags)
        } else {
            @Suppress("DEPRECATION")
            context.packageManager.queryIntentActivities(launcherIntent, 0)
        }

        val apps = matches
            .asSequence()
            .mapNotNull { resolveInfo ->
                val activityInfo = resolveInfo.activityInfo ?: return@mapNotNull null
                val packageName = activityInfo.packageName ?: return@mapNotNull null
                if (packageName == context.packageName) {
                    return@mapNotNull null
                }
                val label = resolveInfo.loadLabel(context.packageManager)?.toString()?.trim()
                if (label.isNullOrEmpty()) {
                    return@mapNotNull null
                }
                JSObject().apply {
                    put("packageName", packageName)
                    put("displayName", label)
                }
            }
            .distinctBy { it.getString("packageName") }
            .sortedBy { it.getString("displayName")?.lowercase() ?: "" }
            .toList()

        call.resolve(JSObject().apply {
            put("apps", JSArray(apps))
        })
    }

    @PluginMethod
    fun selectApps(call: PluginCall) {
        call.resolve(JSObject().apply {
            put("apps", JSArray())
            put("cancelled", true)
        })
    }

    @PluginMethod
    fun blockApps(call: PluginCall) {
        if (!hasUsageAccess() || !canDrawOverlays()) {
            call.resolve(JSObject().apply {
                put("success", false)
                put("endsAt", null)
                put("error", missingPermissionReason())
                put("blockedCount", 0)
            })
            return
        }

        val packageNames = mutableListOf<String>()
        val explicitPackageNames = call.data.optJSONArray("packageNames")
        if (explicitPackageNames != null) {
            for (index in 0 until explicitPackageNames.length()) {
                val packageName = explicitPackageNames.optString(index).trim()
                if (packageName.isNotEmpty()) {
                    packageNames.add(packageName)
                }
            }
        }

        val normalizedPackageNames = packageNames.distinct().sorted()
        if (normalizedPackageNames.isEmpty()) {
            call.resolve(JSObject().apply {
                put("success", false)
                put("endsAt", null)
                put("error", "Select at least one Android app to block.")
                put("blockedCount", 0)
            })
            return
        }

        val durationMinutes = parseDurationMinutes(call)
        val endsAtEpochMs = durationMinutes?.let { System.currentTimeMillis() + (it * 60_000L) }
        AppBlockerStateStore.save(context, normalizedPackageNames, endsAtEpochMs)

        val serviceIntent = Intent(context, AppBlockerForegroundService::class.java).apply {
            action = AppBlockerForegroundService.ACTION_START
        }
        ContextCompat.startForegroundService(context, serviceIntent)

        call.resolve(JSObject().apply {
            put("success", true)
            put("endsAt", endsAtEpochMs?.let { Instant.ofEpochMilli(it).toString() })
            put("blockedCount", normalizedPackageNames.size)
        })
    }

    @PluginMethod
    fun unblockApps(call: PluginCall) {
        AppBlockerStateStore.clear(context)
        context.stopService(
            Intent(context, AppBlockerForegroundService::class.java).apply {
                action = AppBlockerForegroundService.ACTION_STOP
            },
        )

        call.resolve(JSObject().apply {
            put("success", true)
        })
    }

    @PluginMethod
    fun getStatus(call: PluginCall) {
        val saved = AppBlockerStateStore.load(context)
        val permission = buildPermissionResult()
        call.resolve(JSObject().apply {
            put("available", true)
            put("active", saved != null)
            put("platform", "android")
            put("engine", "usage-stats-overlay")
            put("blockedCount", saved?.packageNames?.size ?: 0)
            put("blockedPackageNames", JSArray(saved?.packageNames ?: emptyList<String>()))
            put("endsAt", saved?.endsAtEpochMs?.let { Instant.ofEpochMilli(it).toString() })
            put("permissionStatus", permission.getString("status"))
            val reason = if (saved != null && (!hasUsageAccess() || !canDrawOverlays())) {
                missingPermissionReason()
            } else {
                permission.getString("reason")
            }
            if (!reason.isNullOrBlank()) {
                put("reason", reason)
            }
        })
    }

    private fun parseDurationMinutes(call: PluginCall): Long? {
        val rawValue = call.data.opt("durationMinutes") ?: return null
        return when (rawValue) {
            is Number -> rawValue.toLong()
            is String -> rawValue.toLongOrNull()
            else -> null
        }?.takeIf { it > 0 }
    }

    private fun buildPermissionResult(): JSObject {
        val usageAccess = hasUsageAccess()
        val overlayAccess = canDrawOverlays()
        return JSObject().apply {
            put("status", if (usageAccess && overlayAccess) "granted" else "not-determined")
            put("canRequest", !usageAccess || !overlayAccess)
            val reason = missingPermissionReason()
            if (reason != null) {
                put("reason", reason)
            }
        }
    }

    private fun missingPermissionReason(): String? {
        val missingUsageAccess = !hasUsageAccess()
        val missingOverlayAccess = !canDrawOverlays()
        return when {
            missingUsageAccess && missingOverlayAccess ->
                "Android needs Usage Access and Draw Over Other Apps before Eliza can block apps on this phone."
            missingUsageAccess ->
                "Android needs Usage Access before Eliza can detect and block foreground apps."
            missingOverlayAccess ->
                "Android needs Draw Over Other Apps before Eliza can show the blocking shield."
            else -> null
        }
    }

    private fun hasUsageAccess(): Boolean {
        val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as? AppOpsManager
            ?: return false
        val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            appOps.unsafeCheckOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                android.os.Process.myUid(),
                context.packageName,
            )
        } else {
            @Suppress("DEPRECATION")
            appOps.checkOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                android.os.Process.myUid(),
                context.packageName,
            )
        }
        return mode == AppOpsManager.MODE_ALLOWED
    }

    private fun canDrawOverlays(): Boolean {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(context)
    }

    private fun openSettings(action: String, data: Uri?) {
        val intent = Intent(action).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (data != null) {
                this.data = data
            }
        }
        context.startActivity(intent)
    }
}
