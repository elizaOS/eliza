package ai.eliza.plugins.system

import android.app.Activity
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.widget.ScrollView
import android.widget.TextView

/**
 * Test-only Activity that renders the live [SystemDeviceReader] output on-screen
 * so the on-device instrumented coverage can be captured as a real screenshot /
 * screen recording (issue #9967 evidence). It is `setShowWhenLocked` so it can
 * be captured even on a secure-locked device, and declared exported in the
 * androidTest manifest so it can be launched via `am start`.
 */
class ReaderShowcaseActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        }

        val reader = SystemDeviceReader(this)
        val status = reader.readStatus()
        val settings = reader.readDeviceSettings()

        val text = buildString {
            appendLine("SystemDeviceReader — live on-device reads (#9967)")
            appendLine("package: ${status.packageName}")
            appendLine()
            appendLine("ROLES (live RoleManager):")
            for (r in status.roles) {
                appendLine("  ${r.role}: available=${r.available} held=${r.held}")
            }
            appendLine()
            appendLine("DEVICE SETTINGS (live):")
            appendLine(
                "  brightness=%.2f  mode=%s  canWrite=%s".format(
                    settings.brightness,
                    settings.brightnessMode,
                    settings.canWriteSettings,
                ),
            )
            appendLine("  volumes:")
            for (v in settings.volumes) {
                appendLine("    ${v.stream}: ${v.current}/${v.max}")
            }
        }

        val textView = TextView(this).apply {
            this.text = text
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.parseColor("#0B132B"))
            textSize = 15f
            gravity = Gravity.TOP
            setPadding(56, 120, 56, 56)
        }
        setContentView(ScrollView(this).apply { addView(textView) })
    }
}
