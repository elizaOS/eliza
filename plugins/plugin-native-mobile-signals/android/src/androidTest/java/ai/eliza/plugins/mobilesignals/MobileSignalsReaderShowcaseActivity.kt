package ai.eliza.plugins.mobilesignals

import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject

class MobileSignalsReaderShowcaseActivity : Activity() {
    private lateinit var textView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
            )
        }
        val reader = MobileSignalsDeviceReader(applicationContext)
        val snapshot = reader.buildSnapshot("showcase")
        val metadata = snapshot.getJSONObject("metadata")
        val screenTime = reader.buildScreenTimeStatus()
        val androidStatus = screenTime.getJSONObject("android")
        val summary = reader.collectUsageStatsSummary()

        textView = TextView(this).apply {
            textSize = 18f
            setPadding(36, 36, 36, 36)
            text = buildString {
                appendLine("Mobile Signals Reader")
                appendLine("Package: ${applicationContext.packageName}")
                appendLine("State: ${snapshot.getString("state")}")
                appendLine("Idle state: ${snapshot.getString("idleState")}")
                appendLine("Interactive: ${metadata.getBoolean("isInteractive")}")
                appendLine("Locked: ${metadata.getBoolean("isDeviceLocked")}")
                appendLine("Power save: ${metadata.getBoolean("isPowerSaveMode")}")
                appendLine("Charging: ${metadata.getBoolean("isCharging")}")
                appendLine("Battery: ${metadata.opt("batteryLevel").takeUnless { it == JSONObject.NULL } ?: "unknown"}")
                appendLine("Usage access: ${androidStatus.getBoolean("usageAccessGranted")}")
                appendLine("Usage permission declared: ${androidStatus.getBoolean("packageUsageStatsPermissionDeclared")}")
                appendLine("Usage total ms: ${androidStatus.opt("totalTimeForegroundMs")}")
                appendLine("Usage top app count: ${summary.topApps.size}")
            }
        }
        setContentView(
            ScrollView(this).apply {
                addView(
                    textView,
                    ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                    ),
                )
            },
        )
    }

    fun snapshotText(): String = textView.text.toString()
}
