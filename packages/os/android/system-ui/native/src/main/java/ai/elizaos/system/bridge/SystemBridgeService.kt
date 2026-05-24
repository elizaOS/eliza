package ai.elizaos.system.bridge

import android.app.Service
import android.content.Intent
import android.os.Binder
import android.os.IBinder
import android.util.Log

/**
 * Privileged package anchor for the native system bridge.
 *
 * The launcher owns the WebView-local JavaScript transport; this service makes
 * the platform-signed bridge package concrete, discoverable in dumpsys package
 * and service probes, and gives runtime evidence a stable bound marker.
 */
class SystemBridgeService : Service() {
    private val binder = LocalBinder()

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "ElizaSystemBridge: bound")
    }

    override fun onBind(intent: Intent?): IBinder {
        Log.i(TAG, "ElizaSystemBridge: bound")
        return binder
    }

    inner class LocalBinder : Binder() {
        fun service(): SystemBridgeService = this@SystemBridgeService
    }

    companion object {
        private const val TAG = "ElizaSystemBridge"
    }
}
