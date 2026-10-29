package ai.eliza.plugins.system

import android.Manifest
import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.hardware.camera2.CameraAccessException
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

@CapacitorPlugin(
    name = "ElizaSystem",
    permissions = [Permission(alias = "camera", strings = [Manifest.permission.CAMERA])]
)
open class SystemPlugin : Plugin() {
    /** Host policy; defaults preserve the shared plugin's behavior. Rechecked after role UI returns. */
    protected open fun isRoleEnabled(role: String): Boolean = true
    protected open fun isDefaultAppEnabled(role: String?): Boolean = true

    // Device reads are delegated to a pure, Context-backed reader so they can be
    // exercised by an instrumented androidTest without a Capacitor Bridge / WebView
    // (issue #9967). This plugin stays a thin Capacitor binding: read via the
    // reader, then marshal the result into the unchanged JS wire shape.
    private val reader by lazy { SystemDeviceReader(context) }

    @PluginMethod
    fun getStatus(call: PluginCall) {
        call.resolve(statusToJs(reader.readStatus()))
    }

    @PluginMethod
    open fun requestRole(call: PluginCall) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.reject("Android role requests require Android 10 or newer")
            return
        }

        val roleName = call.getString("role")?.trim()
        val androidRole = SystemDeviceReader.ROLE_MAP[roleName]
        if (roleName.isNullOrEmpty() || androidRole == null) {
            call.reject("role must be one of ${SystemDeviceReader.ROLE_MAP.keys.joinToString(", ")}")
            return
        }

        if (!isRoleEnabled(roleName)) {
            call.reject("Role unavailable in this product")
            return
        }

        val roleManager = context.getSystemService(Context.ROLE_SERVICE) as RoleManager
        if (!roleManager.isRoleAvailable(androidRole)) {
            call.reject("$androidRole is not available on this device")
            return
        }

        if (roleManager.isRoleHeld(androidRole)) {
            call.resolve(roleRequestResult(roleName, true, 0))
            return
        }

        startActivityForResult(
            call,
            roleManager.createRequestRoleIntent(androidRole),
            "handleRoleRequestResult"
        )
    }

    @ActivityCallback
    private fun handleRoleRequestResult(call: PluginCall, result: ActivityResult) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.reject("Android role requests require Android 10 or newer")
            return
        }

        val roleName = call.getString("role")?.trim()
        val androidRole = SystemDeviceReader.ROLE_MAP[roleName]
        if (roleName.isNullOrEmpty() || androidRole == null) {
            call.reject("role must be one of ${SystemDeviceReader.ROLE_MAP.keys.joinToString(", ")}")
            return
        }

        if (!isRoleEnabled(roleName)) {
            call.reject("Role unavailable in this product")
            return
        }

        val roleManager = context.getSystemService(Context.ROLE_SERVICE) as RoleManager
        call.resolve(roleRequestResult(roleName, roleManager.isRoleHeld(androidRole), result.resultCode))
    }

    private fun roleRequestResult(roleName: String, held: Boolean, resultCode: Int): JSObject {
        val result = JSObject()
        result.put("role", roleName)
        result.put("held", held)
        result.put("resultCode", resultCode)
        return result
    }

    @PluginMethod
    fun openSettings(call: PluginCall) {
        // Clear screens above an existing settings target instead of merely
        // resuming whichever page was last visible in its Android task.
        val intent = Intent(Settings.ACTION_SETTINGS)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        context.startActivity(intent)
        call.resolve()
    }

    @PluginMethod
    fun openNetworkSettings(call: PluginCall) {
        val intent = Intent(Settings.ACTION_WIFI_SETTINGS)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        context.startActivity(intent)
        call.resolve()
    }

    @PluginMethod
    fun openWriteSettings(call: PluginCall) {
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS, Uri.parse("package:${context.packageName}"))
        } else {
            Intent(Settings.ACTION_SETTINGS)
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        context.startActivity(intent)
        call.resolve()
    }

    @PluginMethod
    fun openDisplaySettings(call: PluginCall) {
        val intent = Intent(Settings.ACTION_DISPLAY_SETTINGS)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        context.startActivity(intent)
        call.resolve()
    }

    @PluginMethod
    fun openSoundSettings(call: PluginCall) {
        val intent = Intent(Settings.ACTION_SOUND_SETTINGS)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        context.startActivity(intent)
        call.resolve()
    }

    @PluginMethod
    fun getDeviceSettings(call: PluginCall) {
        call.resolve(deviceSettingsToJs(reader.readDeviceSettings()))
    }

    /**
     * Host policy: only a host acting as the launcher may ask Android to expand its shade. By
     * default that means this package holds Android's HOME role right now, so an ordinary app
     * answers `standalone` and never asks. A host whose launcher identity is fixed at build time
     * (a launcher-only flavor) overrides this.
     */
    protected open fun canExpandNotificationShade(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return false
        return try {
            val roles = context.getSystemService(RoleManager::class.java) ?: return false
            roles.isRoleAvailable(RoleManager.ROLE_HOME) && roles.isRoleHeld(RoleManager.ROLE_HOME)
        } catch (unavailable: RuntimeException) {
            false
        }
    }

    /** System switch, transport and power facts; a key Android did not answer is absent (unknown). */
    @PluginMethod
    fun getSystemFacts(call: PluginCall) {
        val facts = JSObject()
        for ((key, value) in SystemFacts.read(context)) facts.put(key, value)
        call.resolve(facts)
    }

    /**
     * Opens one allowlisted Android settings page ([SystemSettingsPages]). Resolves with
     * `specific: false` when only the broader fallback page opened; nothing is changed here.
     */
    @PluginMethod
    fun openSettingsPage(call: PluginCall) {
        val page = call.getString("page")
        if (SystemSettingsPages.actions(page) == null) {
            call.reject("Unsupported settings page")
            return
        }
        val host = activity
        if (host == null) {
            call.reject("This Android settings page is unavailable")
            return
        }
        host.runOnUiThread {
            val opened = SystemSettingsPages.open(page, context.packageName) { intent -> host.startActivity(intent) }
            if (opened < 0) {
                call.reject("This Android settings page is unavailable")
            } else {
                call.resolve(JSObject().apply {
                    put("status", "opened")
                    put("page", page)
                    put("specific", opened == 0)
                })
            }
        }
    }

    /**
     * Asks Android to open its notification shade ([SystemShade]). Only while the host window has
     * focus, so a pull or button on visible Home is the only way to reach it. Resolves with
     * `{status}`; anything but `opened` leaves the caller's fallback to show.
     */
    @PluginMethod
    fun openNotificationShade(call: PluginCall) {
        val host = activity
        if (host == null) {
            call.resolve(JSObject().apply { put("status", SystemShade.NOT_IN_FRONT) })
            return
        }
        host.runOnUiThread {
            val status = if (host.isFinishing || host.isDestroyed || !host.hasWindowFocus()) {
                SystemShade.NOT_IN_FRONT
            } else {
                SystemShade.expand(context, canExpandNotificationShade())
            }
            call.resolve(JSObject().apply { put("status", status) })
        }
    }

    @PluginMethod
    fun setScreenBrightness(call: PluginCall) {
        val brightness = call.getDouble("brightness")
        if (brightness == null || brightness.isNaN()) {
            call.reject("brightness must be a number between 0 and 1")
            return
        }
        val clamped = brightness.coerceIn(0.0, 1.0)
        if (!reader.canWriteSettings()) {
            call.reject("WRITE_SETTINGS permission is required to change system brightness")
            return
        }
        try {
            Settings.System.putInt(
                context.contentResolver,
                Settings.System.SCREEN_BRIGHTNESS_MODE,
                Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL
            )
            Settings.System.putInt(
                context.contentResolver,
                Settings.System.SCREEN_BRIGHTNESS,
                (clamped * 255.0).toInt().coerceIn(0, 255)
            )
            call.resolve(deviceSettingsToJs(reader.readDeviceSettings()))
        } catch (error: RuntimeException) {
            call.reject("Failed to set screen brightness", error)
        }
    }

    @PluginMethod
    fun setVolume(call: PluginCall) {
        val streamName = call.getString("stream")?.trim()
        val stream = SystemDeviceReader.VOLUME_STREAM_MAP[streamName]
        if (streamName.isNullOrEmpty() || stream == null) {
            call.reject("stream must be one of ${SystemDeviceReader.VOLUME_STREAM_MAP.keys.joinToString(", ")}")
            return
        }
        val volume = call.getInt("volume")
        if (volume == null) {
            call.reject("volume is required")
            return
        }
        val showUi = call.getBoolean("showUi") ?: false
        val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val max = audio.getStreamMaxVolume(stream)
        val clamped = volume.coerceIn(0, max)
        val flags = if (showUi) AudioManager.FLAG_SHOW_UI else 0
        try {
            audio.setStreamVolume(stream, clamped, flags)
            call.resolve(volumeToJs(reader.readVolume(streamName, stream, audio)))
        } catch (error: RuntimeException) {
            call.reject("Failed to set $streamName volume", error)
        }
    }

    @PluginMethod
    open fun setFlashlight(call: PluginCall) {
        // Validate the wire value before triggering an Android permission prompt.
        // JSONObject's boolean getter also accepts strings; this API requires a boolean.
        if (call.data.opt("enabled") !is Boolean) {
            call.reject("enabled must be a boolean")
            return
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            call.reject("Flashlight control requires Android 6 or newer")
            return
        }
        if (getPermissionState("camera") != com.getcapacitor.PermissionState.GRANTED) {
            requestPermissionForAlias("camera", call, "handleFlashlightPermissionResult")
            return
        }
        setFlashlightInternal(call)
    }

    @PermissionCallback
    private fun handleFlashlightPermissionResult(call: PluginCall) {
        if (getPermissionState("camera") != com.getcapacitor.PermissionState.GRANTED) {
            call.reject("Camera permission is required to control the flashlight")
            return
        }
        setFlashlightInternal(call)
    }

    private fun setFlashlightInternal(call: PluginCall) {
        val enabled = call.getBoolean("enabled")
        if (enabled == null) {
            call.reject("enabled must be a boolean")
            return
        }

        try {
            val cameraManager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
            val flashlightCameraId = cameraManager.cameraIdList
                .map { cameraId -> cameraId to cameraManager.getCameraCharacteristics(cameraId) }
                .filter { (_, characteristics) ->
                    characteristics.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
                }
                .sortedBy { (_, characteristics) ->
                    if (characteristics.get(CameraCharacteristics.LENS_FACING) ==
                        CameraCharacteristics.LENS_FACING_BACK
                    ) 0 else 1
                }
                .firstOrNull()
                ?.first
            if (flashlightCameraId == null) {
                call.reject("This device does not have an available flashlight")
                return
            }

            cameraManager.setTorchMode(flashlightCameraId, enabled)
            call.resolve(JSObject().apply {
                put("available", true)
                put("enabled", enabled)
            })
        } catch (error: CameraAccessException) {
            call.reject("Flashlight is temporarily unavailable", error)
        } catch (error: SecurityException) {
            call.reject("Camera permission is required to control the flashlight", error)
        }
    }

    private var launcherWatch: AutoCloseable? = null

    /** Installs, removals, enable/disable and profile pause/unlock happen outside the host. The
     * renderer is told that something changed and re-reads the list itself. */
    override fun load() {
        super.load()
        launcherWatch = SystemLauncherApps.watch(context) { packageName, reason ->
            val change = JSObject()
            change.put("reason", reason)
            packageName?.let { change.put("packageName", it) }
            notifyListeners("launcherAppsChanged", change)
        }
    }

    override fun handleOnDestroy() {
        launcherWatch?.close()
        launcherWatch = null
        super.handleOnDestroy()
    }

    /** One entry per launcher activity and Android user, other than the host. The current
     * user's entries come first, sorted by label; icons are opt-in PNG data URLs. */
    @PluginMethod
    fun listLauncherApps(call: PluginCall) {
        val icons = call.getBoolean("icons", false) == true
        val apps = JSArray()
        val listed = try {
            SystemLauncherApps.list(context)
        } catch (error: RuntimeException) {
            // An unreadable inventory is reported, never a partial list and never a crash of Home.
            call.reject("Installed apps could not be read", SystemLauncherApps.FAILED, error)
            return
        }
        for (app in listed) {
            val item = JSObject()
            item.put("packageName", app.packageName)
            item.put("activityName", app.activityName)
            item.put("label", app.label)
            app.user?.let { item.put("user", it) }
            app.profile?.let { item.put("profile", it) }
            if (app.user != null) item.put("locked", app.locked)
            if (icons) iconDataUrl(SystemLauncherApps.iconPng(context.packageManager, app, LAUNCHER_ICON_PX))?.let { item.put("icon", it) }
            apps.put(item)
        }
        val result = JSObject()
        result.put("apps", apps)
        call.resolve(result)
    }

    /** Launches one listed app from an explicit host call; the host owns the user-intent check.
     * With `activityName` (and `user` for another profile) the exact listed entry is re-resolved
     * now; a stale entry is refused with a stable code instead of opening something else. */
    @PluginMethod
    fun launchApp(call: PluginCall) {
        if (SystemLauncherApps.malformedText(call.data, "activityName") ||
            SystemLauncherApps.malformedText(call.data, "user")
        ) {
            call.reject("Choose an installed app")
            return
        }
        val activityName = call.getString("activityName")
        if (activityName == null) {
            if (call.getString("user") != null) {
                call.reject("Choose an installed app")
                return
            }
            val intent = try {
                SystemLauncherApps.launchIntent(context, call.getString("packageName"))
            } catch (error: IllegalArgumentException) {
                call.reject("Choose an installed app")
                return
            }
            if (intent == null) {
                // Worded as the component refusals: removed, disabled, or no openable screen.
                val refusal = SystemLauncherApps.explain(context.packageManager, call.getString("packageName"))
                call.reject(refusal.message, refusal.code)
                return
            }
            startHandoff(call, intent, SystemLauncherApps.FAILED)
            return
        }
        val target = try {
            SystemLauncherApps.resolve(context, call.getString("packageName"), activityName, call.getString("user"))
        } catch (error: IllegalArgumentException) {
            call.reject("Choose an installed app")
            return
        } catch (refusal: SystemLauncherApps.Refusal) {
            call.reject(refusal.message, refusal.code)
            return
        } catch (error: RuntimeException) {
            call.reject("App could not be opened", SystemLauncherApps.FAILED, error)
            return
        }
        val user = target.user
        if (user == null) {
            startHandoff(call, SystemLauncherApps.launchIntent(target.component), SystemLauncherApps.FAILED)
            return
        }
        try {
            context.getSystemService(android.content.pm.LauncherApps::class.java)
                .startMainActivity(target.component, user, null, null)
            call.resolve()
        } catch (error: RuntimeException) {
            // Removed between resolve and start, or refused by Android.
            call.reject("App could not be opened", SystemLauncherApps.FAILED, error)
        }
    }

    /** Resolves, without launching, the handler for a default role (currently "dial"). */
    @PluginMethod
    fun resolveDefaultApp(call: PluginCall) {
        val role = call.getString("role")
        if (!isDefaultAppEnabled(role)) {
            call.reject("Default app unavailable in this product")
            return
        }
        val handler = try {
            SystemLauncherApps.resolveDefault(context, role)
        } catch (error: IllegalArgumentException) {
            call.reject("role must be dial")
            return
        }
        val result = JSObject()
        result.put("role", role)
        result.put("available", handler.available)
        handler.packageName?.let {
            result.put("packageName", it)
            result.put("label", handler.label)
            iconDataUrl(it)?.let { icon -> result.put("icon", icon) }
        }
        call.resolve(result)
    }

    /** Opens the role's handler with no data (an empty dial pad for "dial"). */
    @PluginMethod
    fun openDefaultApp(call: PluginCall) {
        val role = call.getString("role")
        if (!isDefaultAppEnabled(role)) {
            call.reject("Default app unavailable in this product")
            return
        }
        val intent = try {
            SystemLauncherApps.defaultLaunchIntent(context, role)
        } catch (error: IllegalArgumentException) {
            call.reject("role must be dial")
            return
        }
        if (intent == null) {
            call.reject("No app on this device handles $role")
            return
        }
        startHandoff(call, intent)
    }

    private fun startHandoff(call: PluginCall, intent: Intent, code: String? = null) {
        try {
            // Launchers start other apps in their own tasks, like the settings hand-offs above.
            context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            call.resolve()
        } catch (error: RuntimeException) {
            // ActivityNotFoundException, SecurityException, or a component gone since resolve.
            if (code == null) call.reject("App could not be opened", error)
            else call.reject("App could not be opened", code, error)
        }
    }

    /** True when the host is the launcher distribution. Default: it declares a HOME activity. */
    protected open fun isLauncherBuild(): Boolean {
        val home = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).setPackage(context.packageName)
        return try {
            context.packageManager.queryIntentActivities(home, 0).isNotEmpty()
        } catch (error: RuntimeException) {
            false
        }
    }

    /** The host's version name; empty when Android does not report one. */
    protected open fun buildVersion(): String = try {
        context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: ""
    } catch (error: Exception) {
        ""
    }

    /** True only for the assistant entry. Hosts that forward ACTION_ASSIST through their own
     * Activity add their marker extra by overriding this. */
    protected open fun isAssistantLaunch(intent: Intent?): Boolean =
        intent != null && Intent.ACTION_ASSIST == intent.action

    /** Device locale as a BCP 47 tag. */
    protected open fun localeTag(): String = java.util.Locale.getDefault().toLanguageTag()

    /** Android's 24-hour clock setting for this user. */
    protected open fun is24HourClock(): Boolean = android.text.format.DateFormat.is24HourFormat(context)

    @PluginMethod
    fun getBuildInfo(call: PluginCall) {
        val result = JSObject()
        result.put("launcher", isLauncherBuild())
        result.put("version", buildVersion())
        call.resolve(result)
    }

    @PluginMethod
    fun getLaunchInfo(call: PluginCall) {
        val result = JSObject()
        result.put("assistant", isAssistantLaunch(activity?.intent))
        call.resolve(result)
    }

    @PluginMethod
    fun getLocaleInfo(call: PluginCall) {
        val result = JSObject()
        result.put("locale", localeTag())
        result.put("hour24", is24HourClock())
        call.resolve(result)
    }

    private fun iconDataUrl(packageName: String): String? =
        iconDataUrl(SystemLauncherApps.iconPng(context.packageManager, packageName, LAUNCHER_ICON_PX))

    private fun iconDataUrl(png: ByteArray?): String? {
        if (png == null) return null
        return "data:image/png;base64," + android.util.Base64.encodeToString(png, android.util.Base64.NO_WRAP)
    }

    private fun statusToJs(status: SystemDeviceReader.SystemStatus): JSObject {
        val result = JSObject()
        result.put("packageName", status.packageName)
        val roles = JSArray()
        for (role in status.roles) {
            if (!isRoleEnabled(role.role)) continue
            val item = JSObject()
            item.put("role", role.role)
            item.put("androidRole", role.androidRole)
            item.put("available", role.available)
            item.put("held", role.held)
            item.put("holders", JSArray(role.holders))
            roles.put(item)
        }
        result.put("roles", roles)
        return result
    }

    private fun deviceSettingsToJs(settings: SystemDeviceReader.DeviceSettings): JSObject {
        val result = JSObject()
        result.put("brightness", settings.brightness)
        result.put("brightnessMode", settings.brightnessMode)
        result.put("canWriteSettings", settings.canWriteSettings)
        val volumes = JSArray()
        for (volume in settings.volumes) {
            volumes.put(volumeToJs(volume))
        }
        result.put("volumes", volumes)
        return result
    }

    private fun volumeToJs(volume: SystemDeviceReader.VolumeStatus): JSObject {
        val result = JSObject()
        result.put("stream", volume.stream)
        result.put("current", volume.current)
        result.put("max", volume.max)
        return result
    }

    private companion object {
        const val LAUNCHER_ICON_PX = 96
    }
}
