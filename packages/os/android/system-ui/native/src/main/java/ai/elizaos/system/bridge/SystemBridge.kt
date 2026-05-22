package ai.elizaos.system.bridge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.PowerManager
import android.provider.Settings
import android.telephony.SignalStrength
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager
import android.text.format.DateFormat
import org.json.JSONObject
import java.util.TimeZone

/**
 * JS-facing surface for the elizaOS Android system bridge. Methods map 1:1 to
 * channels declared in
 * `packages/os/android/system-ui/src/bridge/bridge-contract.ts`. State methods
 * return a [Subscription] that pushes JSON-encoded payloads to [emit]; command
 * methods drive the matching Android manager/service.
 *
 * Wire-up: registered on the SystemUI replacement `WebView` via
 * `WebView.addJavascriptInterface(SystemBridge(ctx, emit), "__elizaAndroidBridge")`.
 * The bound name is what the JS-side `getBridgeTransport` looks for. [emit]
 * forwards `(channel, jsonPayload)` to the bound transport's `on(...)` handlers.
 *
 * Privileged controls (reboot, shutdown, sleep, airplane mode) require the
 * platform-signed permissions granted to `ai.elizaos.system.bridge` through
 * `privapp-permissions-ai.elizaos.system.bridge.xml`.
 */
class SystemBridge(
    private val context: Context,
    private val emit: (channel: String, payload: String) -> Unit,
) {
    private val appContext: Context = context.applicationContext

    private val audioManager: AudioManager
        get() = appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val connectivityManager: ConnectivityManager
        get() = appContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private val wifiManager: WifiManager
        get() = appContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    private val telephonyManager: TelephonyManager
        get() = appContext.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
    private val powerManager: PowerManager
        get() = appContext.getSystemService(Context.POWER_SERVICE) as PowerManager

    fun subscribeWifi(): Subscription {
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = emitWifi()
            override fun onLost(network: Network) = emitWifi()
            override fun onCapabilitiesChanged(
                network: Network,
                caps: NetworkCapabilities,
            ) = emitWifi()
        }
        connectivityManager.registerDefaultNetworkCallback(callback)
        emitWifi()
        return Subscription { connectivityManager.unregisterNetworkCallback(callback) }
    }

    private fun emitWifi() {
        val caps = connectivityManager.getNetworkCapabilities(connectivityManager.activeNetwork)
        val onWifi = caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
        val info = wifiManager.connectionInfo
        val payload = JSONObject()
            .put("connected", onWifi && info != null && info.networkId != -1)
        if (onWifi && info != null) {
            val ssid = info.ssid?.trim('"')
            if (!ssid.isNullOrEmpty() && ssid != WifiManager.UNKNOWN_SSID) {
                payload.put("ssid", ssid)
            }
            payload.put("signalDbm", info.rssi)
        }
        emit("eliza.android.wifi.state", payload.toString())
    }

    fun subscribeConnectivity(): Subscription {
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onCapabilitiesChanged(
                network: Network,
                caps: NetworkCapabilities,
            ) = emitConnectivity()
            override fun onLost(network: Network) = emitConnectivity()
        }
        connectivityManager.registerDefaultNetworkCallback(callback)
        emitConnectivity()
        return Subscription { connectivityManager.unregisterNetworkCallback(callback) }
    }

    private fun emitConnectivity() {
        val caps = connectivityManager.getNetworkCapabilities(connectivityManager.activeNetwork)
        val network = when {
            caps == null -> "none"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "none"
        }
        val metered = connectivityManager.isActiveNetworkMetered
        val payload = JSONObject()
            .put("network", network)
            .put("metered", metered)
        emit("eliza.android.connectivity.state", payload.toString())
    }

    fun subscribeCell(): Subscription {
        val executor = appContext.mainExecutor
        val callback = object : TelephonyCallback(), TelephonyCallback.SignalStrengthsListener {
            override fun onSignalStrengthsChanged(signalStrength: SignalStrength) {
                emitCell(signalStrength)
            }
        }
        telephonyManager.registerTelephonyCallback(executor, callback)
        emitCell(telephonyManager.signalStrength)
        return Subscription { telephonyManager.unregisterTelephonyCallback(callback) }
    }

    private fun emitCell(signalStrength: SignalStrength?) {
        val bars = signalStrength?.level?.coerceIn(0, 5) ?: 0
        val airplaneMode = Settings.Global.getInt(
            appContext.contentResolver,
            Settings.Global.AIRPLANE_MODE_ON,
            0,
        ) != 0
        val payload = JSONObject()
            .put("strengthBars", bars)
            .put("airplaneMode", airplaneMode)
        val carrier = telephonyManager.networkOperatorName
        if (!carrier.isNullOrEmpty()) {
            payload.put("carrier", carrier)
        }
        emit("eliza.android.cell.state", payload.toString())
    }

    fun subscribeAudio(): Subscription {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) = emitAudio()
        }
        appContext.registerReceiver(receiver, IntentFilter(VOLUME_CHANGED_ACTION))
        emitAudio()
        return Subscription { appContext.unregisterReceiver(receiver) }
    }

    private fun emitAudio() {
        val max = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)
        val current = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC)
        val muted = audioManager.isStreamMute(AudioManager.STREAM_MUSIC) || current == 0
        val payload = JSONObject()
            .put("level", current.toFloat() / max.toFloat())
            .put("muted", muted)
            .put("outputDevice", currentOutputDeviceName())
        emit("eliza.android.audio.state", payload.toString())
    }

    private fun currentOutputDeviceName(): String {
        val devices = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        val active = devices.firstOrNull {
            it.type == android.media.AudioDeviceInfo.TYPE_BLUETOOTH_A2DP ||
                it.type == android.media.AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
                it.type == android.media.AudioDeviceInfo.TYPE_WIRED_HEADSET
        } ?: devices.firstOrNull { it.type == android.media.AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
        return active?.productName?.toString() ?: "Speaker"
    }

    fun subscribeBattery(): Subscription {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) = emitBattery(intent)
        }
        val sticky = appContext.registerReceiver(receiver, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        emitBattery(sticky)
        return Subscription { appContext.unregisterReceiver(receiver) }
    }

    private fun emitBattery(intent: Intent?) {
        val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val percent = if (level >= 0 && scale > 0) (level * 100) / scale else 0
        val status = intent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
            status == BatteryManager.BATTERY_STATUS_FULL
        val payload = JSONObject()
            .put("percent", percent)
            .put("charging", charging)
        emit("eliza.android.battery.state", payload.toString())
    }

    fun subscribeTime(): Subscription {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) = emitTime()
        }
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_TIME_TICK)
            addAction(Intent.ACTION_TIME_CHANGED)
            addAction(Intent.ACTION_TIMEZONE_CHANGED)
        }
        appContext.registerReceiver(receiver, filter)
        emitTime()
        return Subscription { appContext.unregisterReceiver(receiver) }
    }

    private fun emitTime() {
        val locale = appContext.resources.configuration.locales[0]
        val payload = JSONObject()
            .put("now", System.currentTimeMillis())
            .put("locale", locale.toLanguageTag())
            .put("timeZone", TimeZone.getDefault().id)
            .put("is24Hour", DateFormat.is24HourFormat(appContext))
        emit("eliza.android.time.state", payload.toString())
    }

    fun subscribeLockscreen(): Subscription {
        val keyguard = appContext.getSystemService(Context.KEYGUARD_SERVICE)
            as android.app.KeyguardManager
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) = emitLockscreen(keyguard)
        }
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_USER_PRESENT)
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_SCREEN_ON)
        }
        appContext.registerReceiver(receiver, filter)
        emitLockscreen(keyguard)
        return Subscription { appContext.unregisterReceiver(receiver) }
    }

    private fun emitLockscreen(keyguard: android.app.KeyguardManager) {
        val payload = JSONObject()
            .put("locked", keyguard.isDeviceLocked)
            .put("secure", keyguard.isKeyguardSecure)
        emit("eliza.android.lockscreen.state", payload.toString())
    }

    fun setAudioLevel(level: Float) {
        val max = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        val target = (level.coerceIn(0f, 1f) * max).toInt()
        audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, target, 0)
        emitAudio()
    }

    fun setAudioMuted(muted: Boolean) {
        val direction = if (muted) AudioManager.ADJUST_MUTE else AudioManager.ADJUST_UNMUTE
        audioManager.adjustStreamVolume(AudioManager.STREAM_MUSIC, direction, 0)
        emitAudio()
    }

    fun toggleAirplaneMode() {
        val enabled = Settings.Global.getInt(
            appContext.contentResolver,
            Settings.Global.AIRPLANE_MODE_ON,
            0,
        ) != 0
        Settings.Global.putInt(
            appContext.contentResolver,
            Settings.Global.AIRPLANE_MODE_ON,
            if (enabled) 0 else 1,
        )
        val intent = Intent(Intent.ACTION_AIRPLANE_MODE_CHANGED)
            .putExtra("state", !enabled)
        appContext.sendBroadcast(intent)
        emitCell(telephonyManager.signalStrength)
    }

    fun requestShutdown() {
        powerManager.javaClass
            .getMethod("shutdown", Boolean::class.java, String::class.java, Boolean::class.java)
            .invoke(powerManager, false, "userrequested", false)
    }

    fun requestRestart() {
        powerManager.reboot(null)
    }

    fun requestSleep() {
        powerManager.javaClass
            .getMethod("goToSleep", Long::class.java)
            .invoke(powerManager, android.os.SystemClock.uptimeMillis())
    }

    fun openSettings() {
        val intent = Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        appContext.startActivity(intent)
    }

    fun dismissLockscreen() {
        val keyguard = appContext.getSystemService(Context.KEYGUARD_SERVICE)
            as android.app.KeyguardManager
        @Suppress("DEPRECATION")
        keyguard.newKeyguardLock("eliza-system-bridge").disableKeyguard()
    }

    companion object {
        private const val VOLUME_CHANGED_ACTION = "android.media.VOLUME_CHANGED_ACTION"
    }
}

fun interface Subscription {
    fun cancel()
}
