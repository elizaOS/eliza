package ai.eliza.plugins.swabble

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.speech.SpeechRecognizer
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject

internal object SwabbleAndroidPlatformProbe {
    fun speechRecognitionAvailable(context: Context): Boolean {
        return SpeechRecognizer.isRecognitionAvailable(context)
    }

    fun permissionResult(microphone: String, speechRecognitionAvailable: Boolean): JSObject {
        return JSObject().apply {
            put("microphone", microphone)
            put("speechRecognition", if (speechRecognitionAvailable) "granted" else "not_supported")
        }
    }

    fun audioDevices(context: Context, selectedDeviceId: String?): JSArray {
        val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val devices = JSArray()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val inputDevices = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS)
            for (device in inputDevices) {
                devices.put(JSObject().apply {
                    val id = device.id.toString()
                    val product = device.productName?.toString().orEmpty()
                    put("id", id)
                    put(
                        "name",
                        deviceTypeName(device.type) +
                            if (product.isNotEmpty()) " ($product)" else ""
                    )
                    put("isDefault", id == (selectedDeviceId ?: inputDevices.firstOrNull()?.id?.toString()))
                })
            }
        }

        if (devices.length() == 0) {
            devices.put(JSObject().apply {
                put("id", "default")
                put("name", "Default Microphone")
                put("isDefault", true)
            })
        }

        return devices
    }

    fun deviceTypeName(type: Int): String {
        return when (type) {
            AudioDeviceInfo.TYPE_BUILTIN_MIC -> "Built-in Microphone"
            AudioDeviceInfo.TYPE_WIRED_HEADSET -> "Wired Headset"
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "Bluetooth SCO"
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "Bluetooth A2DP"
            AudioDeviceInfo.TYPE_USB_DEVICE -> "USB Device"
            AudioDeviceInfo.TYPE_USB_ACCESSORY -> "USB Accessory"
            AudioDeviceInfo.TYPE_TELEPHONY -> "Telephony"
            else -> "Audio Input"
        }
    }
}
