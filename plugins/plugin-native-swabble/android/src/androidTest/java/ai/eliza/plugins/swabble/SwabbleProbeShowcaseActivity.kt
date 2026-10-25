package ai.eliza.plugins.swabble

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.widget.ScrollView
import android.widget.TextView

class SwabbleProbeShowcaseActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        actionBar?.hide()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        }

        val microphone = if (
            checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        ) {
            "granted"
        } else {
            "denied"
        }
        val speechAvailable = SwabbleAndroidPlatformProbe.speechRecognitionAvailable(this)
        val permissions = SwabbleAndroidPlatformProbe.permissionResult(microphone, speechAvailable)
        val devices = SwabbleAndroidPlatformProbe.audioDevices(this, selectedDeviceId = null)

        val text = buildString {
            appendLine("Swabble Android platform probe (#9967)")
            appendLine("package: $packageName")
            appendLine("microphone: ${permissions.getString("microphone")}")
            appendLine("speechRecognition: ${permissions.getString("speechRecognition")}")
            appendLine()
            appendLine("Audio input devices:")
            for (i in 0 until devices.length()) {
                val device = devices.getJSONObject(i)
                appendLine(
                    "  ${device.getString("id")}  ${device.getString("name")}" +
                        "  default=${device.getBoolean("isDefault")}"
                )
            }
        }

        setContentView(ScrollView(this).apply {
            setBackgroundColor(Color.parseColor("#101820"))
            addView(TextView(this@SwabbleProbeShowcaseActivity).apply {
                this.text = text
                setTextColor(Color.WHITE)
                textSize = 16f
                setPadding(48, 96, 48, 48)
            })
        })
    }
}
