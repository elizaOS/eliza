package ai.eliza.plugins.location

import android.app.Activity
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.widget.ScrollView
import android.widget.TextView

/**
 * Test-only Activity that renders live [LocationFixReader] output on-screen
 * for screenshot / screen recording evidence (issue #9967).
 */
class LocationReaderShowcaseActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        }

        val reader = LocationFixReader(this)
        val providers = reader.readProviderStatus()
        val foregroundStatus = reader.readForegroundPermissionStatus(this)

        val text = buildString {
            appendLine("LocationFixReader - live on-device reads (#9967)")
            appendLine("package: $packageName")
            appendLine()
            appendLine("PERMISSIONS:")
            appendLine("  foreground: $foregroundStatus")
            appendLine("  background: ${reader.readBackgroundPermissionStatus(foregroundStatus)}")
            appendLine()
            appendLine("PROVIDERS (live LocationManager):")
            appendLine("  gps: ${providers.gpsEnabled}")
            appendLine("  network: ${providers.networkEnabled}")
            appendLine("  passive: ${providers.passiveEnabled}")
            appendLine("  enabled: ${providers.enabledProviders.joinToString()}")
        }

        val textView = TextView(this).apply {
            this.text = text
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.parseColor("#102A43"))
            textSize = 15f
            gravity = Gravity.TOP
            setPadding(56, 120, 56, 56)
        }
        setContentView(ScrollView(this).apply { addView(textView) })
    }
}
