package ai.elizaos.system.bridge

/**
 * JS-facing surface for the elizaOS Android system bridge. Methods here map
 * 1:1 to channels declared in
 * `packages/os/android/system-ui/src/bridge/bridge-contract.ts`. Every
 * method is a stub — see `README.md` for the binding plan.
 *
 * Wire-up assumption: this class is registered on the SystemUI replacement
 * `WebView` via `WebView.addJavascriptInterface(SystemBridge(ctx), "__elizaAndroidBridge")`.
 * The bound name is what the JS-side `getBridgeTransport` looks for.
 */
class SystemBridge {

    fun subscribeWifi(): Subscription {
        // IMPL: ConnectivityManager.registerDefaultNetworkCallback + WifiManager.getConnectionInfo
        throw NotImplementedError("eliza-android-system-bridge: subscribeWifi not yet wired")
    }

    fun subscribeConnectivity(): Subscription {
        // IMPL: ConnectivityManager.NetworkCallback (DEFAULT + isActiveNetworkMetered)
        throw NotImplementedError("eliza-android-system-bridge: subscribeConnectivity not yet wired")
    }

    fun subscribeCell(): Subscription {
        // IMPL: TelephonyManager.PhoneStateListener + LISTEN_SIGNAL_STRENGTHS
        //       (TelephonyCallback.SignalStrengthsListener on API 31+)
        throw NotImplementedError("eliza-android-system-bridge: subscribeCell not yet wired")
    }

    fun subscribeAudio(): Subscription {
        // IMPL: AudioManager.getStreamVolume + STREAM_*_VOLUME_CHANGED broadcast
        throw NotImplementedError("eliza-android-system-bridge: subscribeAudio not yet wired")
    }

    fun subscribeBattery(): Subscription {
        // IMPL: BATTERY_CHANGED intent + BatteryManager
        throw NotImplementedError("eliza-android-system-bridge: subscribeBattery not yet wired")
    }

    fun subscribeTime(): Subscription {
        // IMPL: Intent.ACTION_TIME_TICK + Calendar.getInstance().timeZone
        throw NotImplementedError("eliza-android-system-bridge: subscribeTime not yet wired")
    }

    fun subscribeLockscreen(): Subscription {
        // IMPL: KeyguardManager.isDeviceLocked + KeyguardManager.isKeyguardSecure
        throw NotImplementedError("eliza-android-system-bridge: subscribeLockscreen not yet wired")
    }

    fun setAudioLevel(level: Float) {
        // IMPL: AudioManager.setStreamVolume(STREAM_MUSIC, …, 0)
        throw NotImplementedError("eliza-android-system-bridge: setAudioLevel not yet wired")
    }

    fun setAudioMuted(muted: Boolean) {
        // IMPL: AudioManager.adjustStreamVolume(ADJUST_MUTE / ADJUST_UNMUTE, 0)
        throw NotImplementedError("eliza-android-system-bridge: setAudioMuted not yet wired")
    }

    fun toggleAirplaneMode() {
        // IMPL: Settings.Global.putInt(AIRPLANE_MODE_ON) + broadcast
        //       ACTION_AIRPLANE_MODE_CHANGED — needs WRITE_SECURE_SETTINGS
        //       (system signature).
        throw NotImplementedError("eliza-android-system-bridge: toggleAirplaneMode not yet wired")
    }

    fun requestShutdown() {
        // IMPL: PowerManager.shutdown via system signature permission
        throw NotImplementedError("eliza-android-system-bridge: requestShutdown not yet wired")
    }

    fun requestRestart() {
        // IMPL: PowerManager.reboot(null) — REBOOT permission, system signature
        throw NotImplementedError("eliza-android-system-bridge: requestRestart not yet wired")
    }

    fun requestSleep() {
        // IMPL: PowerManager.goToSleep — DEVICE_POWER permission, system signature
        throw NotImplementedError("eliza-android-system-bridge: requestSleep not yet wired")
    }

    fun openSettings() {
        // IMPL: Context.startActivity(Intent(Settings.ACTION_SETTINGS))
        throw NotImplementedError("eliza-android-system-bridge: openSettings not yet wired")
    }

    fun dismissLockscreen() {
        // IMPL: KeyguardManager.requestDismissKeyguard from a foreground activity
        throw NotImplementedError("eliza-android-system-bridge: dismissLockscreen not yet wired")
    }
}

interface Subscription {
    fun cancel()
}
