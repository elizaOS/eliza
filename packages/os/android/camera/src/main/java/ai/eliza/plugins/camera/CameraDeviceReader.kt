package ai.eliza.plugins.camera

import android.content.Context
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager

/**
 * Pure, [Context]-backed reader for the camera enumeration that
 * [CameraPlugin.getDevices] exposes (id / facing / flash / zoom / sizes / fps).
 *
 * Extracted from the Capacitor plugin so the real `CameraManager` enumeration
 * can be exercised by an instrumented `androidTest` on a real device/emulator
 * without a Capacitor `Bridge`/WebView (issue #9967). Camera *enumeration*
 * (`cameraIdList` + characteristics) needs no runtime permission — only opening
 * a camera does — so this read is permission-light and keyguard-tolerant.
 * [CameraPlugin] delegates to it and builds the same JS array.
 */
class CameraDeviceReader(private val context: Context) {

    data class Resolution(val width: Int, val height: Int)

    data class CameraDevice(
        val deviceId: String,
        val direction: String,
        val hasFlash: Boolean,
        val maxZoom: Double,
        val resolutions: List<Resolution>,
        val frameRates: List<Int>,
    )

    fun readDevices(): List<CameraDevice> {
        val cameraManager =
            context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        return cameraManager.cameraIdList.map { cameraId ->
            val characteristics = cameraManager.getCameraCharacteristics(cameraId)
            val direction = when (characteristics.get(CameraCharacteristics.LENS_FACING)) {
                CameraCharacteristics.LENS_FACING_FRONT -> "front"
                CameraCharacteristics.LENS_FACING_BACK -> "back"
                else -> "external"
            }
            val hasFlash =
                characteristics.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) ?: false
            val maxZoom =
                characteristics.get(CameraCharacteristics.SCALER_AVAILABLE_MAX_DIGITAL_ZOOM) ?: 1f

            val streamConfigMap =
                characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
            val outputSizes = streamConfigMap?.getOutputSizes(ImageFormat.JPEG) ?: arrayOf()
            val resolutions = outputSizes.take(10).map { Resolution(it.width, it.height) }

            val fpsRanges =
                characteristics.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)
            val rateSet = mutableSetOf<Int>()
            fpsRanges?.forEach { rateSet.add(it.upper) }
            val frameRates = rateSet.sortedDescending()

            CameraDevice(
                deviceId = cameraId,
                direction = direction,
                hasFlash = hasFlash,
                maxZoom = maxZoom.toDouble(),
                resolutions = resolutions,
                frameRates = frameRates,
            )
        }
    }
}
