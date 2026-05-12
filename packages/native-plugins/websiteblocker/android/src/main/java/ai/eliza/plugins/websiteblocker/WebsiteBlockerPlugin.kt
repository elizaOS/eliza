package ai.eliza.plugins.websiteblocker

import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.provider.Settings
import androidx.activity.result.ActivityResult
import androidx.core.content.ContextCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import java.time.Instant

@CapacitorPlugin(name = "ElizaWebsiteBlocker")
class WebsiteBlockerPlugin : Plugin() {
    private data class PendingStartRequest(
        val websites: List<String>,
        val endsAtEpochMs: Long?,
    )

    private var pendingStartRequest: PendingStartRequest? = null

    @PluginMethod
    fun getStatus(call: PluginCall) {
        call.resolve(buildStatus())
    }

    @PluginMethod
    fun startBlock(call: PluginCall) {
        val websites = extractWebsites(call)
        if (websites.isEmpty()) {
            call.resolve(JSObject().apply {
                put("success", false)
                put("error", "Provide at least one public website hostname, such as x.com or twitter.com.")
            })
            return
        }

        val durationMinutes = parseDurationMinutes(call)
        val endsAtEpochMs = durationMinutes?.let { System.currentTimeMillis() + it * 60_000 }
        val permissionIntent = VpnService.prepare(context)
        if (permissionIntent != null) {
            pendingStartRequest = PendingStartRequest(websites, endsAtEpochMs)
            startActivityForResult(call, permissionIntent, "handleVpnPermissionResult")
            return
        }

        startBlockInternal(websites, endsAtEpochMs)
        call.resolve(buildStartResult(websites, durationMinutes, endsAtEpochMs))
    }

    @PluginMethod
    fun stopBlock(call: PluginCall) {
        WebsiteBlockerStateStore.clear(context)
        context.stopService(Intent(context, WebsiteBlockerVpnService::class.java).apply {
            action = WebsiteBlockerVpnService.ACTION_STOP
        })

        call.resolve(JSObject().apply {
            put("success", true)
            put("removed", true)
            put("status", JSObject().apply {
                put("active", false)
                put("endsAt", null)
                put("websites", JSArray())
                put("requestedWebsites", JSArray())
                put("blockedWebsites", JSArray())
                put("allowedWebsites", JSArray())
                put("matchMode", "exact")
                put("canUnblockEarly", true)
                put("requiresElevation", permissionRequiresConsent())
            })
        })
    }

    @PluginMethod
    override fun checkPermissions(call: PluginCall) {
        call.resolve(buildPermissionResult())
    }

    @PluginMethod
    override fun requestPermissions(call: PluginCall) {
        val permissionIntent = VpnService.prepare(context)
        if (permissionIntent == null) {
            call.resolve(buildPermissionResult())
            return
        }
        startActivityForResult(call, permissionIntent, "handleVpnPermissionResult")
    }

    @PluginMethod
    fun openSettings(call: PluginCall) {
        val activity = activity
        if (activity == null) {
            call.resolve(JSObject().apply {
                put("opened", false)
            })
            return
        }

        activity.startActivity(Intent(Settings.ACTION_VPN_SETTINGS))
        call.resolve(JSObject().apply {
            put("opened", true)
        })
    }

    @ActivityCallback
    private fun handleVpnPermissionResult(call: PluginCall, result: ActivityResult) {
        if (result.resultCode != android.app.Activity.RESULT_OK) {
            if (pendingStartRequest != null) {
                pendingStartRequest = null
                call.resolve(JSObject().apply {
                    put("success", false)
                    put("error", "Android VPN consent was not granted.")
                })
                return
            }

            call.resolve(buildPermissionResult())
            return
        }

        val pendingStart = pendingStartRequest
        if (pendingStart != null) {
            pendingStartRequest = null
            startBlockInternal(
                pendingStart.websites,
                pendingStart.endsAtEpochMs,
            )
            call.resolve(
                buildStartResult(
                    pendingStart.websites,
                    durationMinutesFromEndsAt(pendingStart.endsAtEpochMs),
                    pendingStart.endsAtEpochMs,
                ),
            )
            return
        }

        call.resolve(buildPermissionResult())
    }

    private fun startBlockInternal(
        websites: List<String>,
        endsAtEpochMs: Long?,
    ) {
        WebsiteBlockerStateStore.save(context, websites, endsAtEpochMs)
        val serviceIntent = Intent(context, WebsiteBlockerVpnService::class.java).apply {
            action = WebsiteBlockerVpnService.ACTION_START
            putStringArrayListExtra(
                WebsiteBlockerVpnService.EXTRA_WEBSITES,
                ArrayList(websites),
            )
            putExtra(
                WebsiteBlockerVpnService.EXTRA_ENDS_AT,
                endsAtEpochMs ?: -1L,
            )
        }
        ContextCompat.startForegroundService(context, serviceIntent)
    }

    private fun durationMinutesFromEndsAt(endsAtEpochMs: Long?): Long? {
        if (endsAtEpochMs == null) return null
        val remainingMs = endsAtEpochMs - System.currentTimeMillis()
        return if (remainingMs <= 0) 0 else kotlin.math.ceil(remainingMs / 60_000.0).toLong()
    }

    private fun buildStartResult(
        websites: List<String>,
        durationMinutes: Long?,
        endsAtEpochMs: Long?,
    ): JSObject {
        return JSObject().apply {
            put("success", true)
            put(
                "endsAt",
                endsAtEpochMs?.let { Instant.ofEpochMilli(it).toString() },
            )
            put("request", JSObject().apply {
                put("websites", JSArray(websites))
                put("durationMinutes", durationMinutes)
            })
        }
    }

    private fun buildPermissionResult(): JSObject {
        val granted = !permissionRequiresConsent()
        return JSObject().apply {
            put("status", if (granted) "granted" else "not-determined")
            put("canRequest", !granted)
            if (!granted) {
                put(
                    "reason",
                    "Android needs VPN consent before Eliza can block websites system-wide on this phone.",
                )
            }
        }
    }

    private fun buildStatus(): JSObject {
        val saved = WebsiteBlockerStateStore.load(context)
        val permission = buildPermissionResult()
        return JSObject().apply {
            put("available", true)
            put("active", saved != null)
            put("hostsFilePath", null)
            put(
                "endsAt",
                saved?.endsAtEpochMs?.let { Instant.ofEpochMilli(it).toString() },
            )
            put("websites", JSArray(saved?.requestedWebsites ?: emptyList<String>()))
            put("requestedWebsites", JSArray(saved?.requestedWebsites ?: emptyList<String>()))
            put("blockedWebsites", JSArray(saved?.blockedWebsites ?: emptyList<String>()))
            put("allowedWebsites", JSArray(saved?.allowedWebsites ?: emptyList<String>()))
            put("matchMode", saved?.matchMode ?: "exact")
            put("canUnblockEarly", true)
            put("requiresElevation", permissionRequiresConsent())
            put("engine", "vpn-dns")
            put("platform", "android")
            put("supportsElevationPrompt", permissionRequiresConsent())
            put(
                "elevationPromptMethod",
                if (permissionRequiresConsent()) "vpn-consent" else null,
            )
            put("permissionStatus", permission.getString("status"))
            put("canRequestPermission", permission.getBool("canRequest"))
            put("canOpenSystemSettings", true)
            val reason = when {
                saved != null && !WebsiteBlockerVpnService.isRunning() ->
                    "Website blocking is configured and the VPN service is reconnecting."
                permissionRequiresConsent() ->
                    permission.getString("reason")
                else -> null
            }
            if (reason != null) {
                put("reason", reason)
            }
        }
    }

    private fun extractWebsites(call: PluginCall): List<String> {
        val websites = mutableListOf<String>()
        val explicitWebsites = call.data.optJSONArray("websites")
        if (explicitWebsites != null) {
            for (index in 0 until explicitWebsites.length()) {
                val value = explicitWebsites.optString(index)
                WebsiteBlockerStateStore.normalizeHostname(value)?.let(websites::add)
            }
        }

        val text = call.getString("text")
        if (!text.isNullOrBlank()) {
            text.split(Regex("[\\s,]+"))
                .mapNotNull(WebsiteBlockerStateStore::normalizeHostname)
                .forEach(websites::add)
        }

        return websites.distinct()
    }

    private fun parseDurationMinutes(call: PluginCall): Long? {
        val rawValue = call.data.opt("durationMinutes") ?: return null
        return when (rawValue) {
            is Number -> rawValue.toLong()
            is String -> rawValue.toLongOrNull()
            else -> null
        }?.takeIf { it > 0 }
    }

    private fun permissionRequiresConsent(): Boolean {
        return VpnService.prepare(context) != null
    }
}
