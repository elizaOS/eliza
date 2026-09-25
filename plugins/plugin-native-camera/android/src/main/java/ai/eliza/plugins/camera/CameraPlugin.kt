/**
 * Owns Android camera preview, capture and recording for the Capacitor bridge.
 * Recording calls settle from CameraX lifecycle events; finalized media metadata
 * and output URIs describe the actual artifact rather than preview preferences.
 */
package ai.eliza.plugins.camera

import android.Manifest
import android.content.ContentValues
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CaptureResult
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.TotalCaptureResult
import android.hardware.camera2.CameraManager
import android.net.Uri
import android.media.MediaMetadataRetriever
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.MediaStore
import android.util.Base64
import android.util.Size
import android.util.Range
import android.view.ViewGroup
import androidx.camera.core.*
import androidx.camera.camera2.interop.Camera2CameraControl
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.CaptureRequestOptions
import androidx.camera.camera2.interop.Camera2Interop
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.*
import androidx.core.content.ContextCompat
import androidx.exifinterface.media.ExifInterface
import androidx.lifecycle.LifecycleOwner
import com.google.common.util.concurrent.ListenableFuture
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.io.ByteArrayOutputStream
import java.io.File
import java.text.SimpleDateFormat
import java.util.*
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.roundToInt

@CapacitorPlugin(
    name = "ElizaCamera",
    permissions = [
        Permission(alias = "camera", strings = [Manifest.permission.CAMERA]),
        Permission(alias = "microphone", strings = [Manifest.permission.RECORD_AUDIO]),
        Permission(alias = "storage", strings = [Manifest.permission.WRITE_EXTERNAL_STORAGE])
    ]
)
class CameraPlugin : Plugin() {

    private var cameraProvider: ProcessCameraProvider? = null
    private var preview: Preview? = null
    private var imageCapture: ImageCapture? = null
    private var videoCapture: VideoCapture<Recorder>? = null
    private var camera: Camera? = null
    private var previewView: androidx.camera.view.PreviewView? = null
    private var cameraExecutor: ExecutorService? = null
    private class RecordingSession(val startCall: PluginCall, val file: File?) {
        var recording: Recording? = null
        var started = false
        var startSettled = false
        var stopping = false
        var duration = 0.0
        var fileSize = 0L
        val stopCalls = mutableListOf<PluginCall>()
    }

    private var recordingSession: RecordingSession? = null
    private var completedRecording: JSObject? = null
    private var completedRecordingError: Exception? = null
    private val recordingPermissionCalls = mutableSetOf<PluginCall>()
    private var destroyed = false
    private var pendingPreviewCall: PluginCall? = null
    private var currentCameraSelector = CameraSelector.DEFAULT_BACK_CAMERA
    private var currentDirection = "back"
    private var switchingCamera = false
    private val pendingCameraSwitches = ArrayDeque<PluginCall>()
    private var whiteBalanceRequestId = 0L
    private var requestedExposureEv = 0.0
    private data class FocusSetting(val preset: String, val mode: Int, val distance: Float?)
    private data class FocusObservation(val cameraId: String, val distance: Float)
    private var observedFocus: FocusObservation? = null
    private var confirmedFocus: FocusSetting? = null
    private val manualFocusDistances = mutableMapOf<String, Float>()
    private var focusRequestId = 0L

    private val frameDelivery = Handler(Looper.getMainLooper())
    private var previewEpoch = 0L
    private var lastFrameEventNanos = 0L

    // Track current preview resolution for reference.
    private var currentPreviewWidth = 1920
    private var currentPreviewHeight = 1080

    private val currentSettings = Collections.synchronizedMap(mutableMapOf<String, Any>(
        "flash" to "off",
        "zoom" to 1.0f,
        "focusMode" to "continuous",
        "exposureMode" to "continuous",
        "exposureCompensation" to 0f,
        "whiteBalance" to "auto"
    ))

    // ---- Device Enumeration ----

    @PluginMethod
    fun getDevices(call: PluginCall) {
        try {
            // Device enumeration is delegated to CameraDeviceReader so it can be
            // exercised by an instrumented androidTest without a Capacitor Bridge
            // (issue #9967); the JS array shape below is unchanged.
            val devices = JSArray()
            for (device in CameraDeviceReader(context).readDevices()) {
                val resolutions = JSArray()
                device.resolutions.forEach { size ->
                    resolutions.put(JSObject().apply {
                        put("width", size.width)
                        put("height", size.height)
                    })
                }
                val frameRates = JSArray()
                device.frameRates.forEach { frameRates.put(it) }

                devices.put(JSObject().apply {
                    put("deviceId", device.deviceId)
                    put("label", "Camera ${device.deviceId} (${device.direction})")
                    put("direction", device.direction)
                    put("hasFlash", device.hasFlash)
                    put("hasZoom", true)
                    put("maxZoom", device.maxZoom)
                    put("supportedResolutions", resolutions)
                    put("supportedFrameRates", frameRates)
                })
            }

            call.resolve(JSObject().apply {
                put("devices", devices)
            })
        } catch (e: Exception) {
            // error-policy:J1 camera enumeration failures reject the bridge call.
            call.reject("Failed to enumerate cameras: ${e.message}")
        }
    }

    // ---- Preview Lifecycle ----

    @PluginMethod
    fun startPreview(call: PluginCall) {
        activity.runOnUiThread {
            if (destroyed) {
                call.reject("Camera plugin was destroyed", "CAMERA_DESTROYED")
                return@runOnUiThread
            }
            stopPreviewInternal()
            pendingPreviewCall = call
            if (!hasRequiredPermissions()) {
                requestPermissionForAlias("camera", call, "handleCameraPermissionResult")
            } else {
                startPreviewInternal(call)
            }
        }
    }

    @PermissionCallback
    private fun handleCameraPermissionResult(call: PluginCall) {
        activity.runOnUiThread {
            if (pendingPreviewCall !== call || destroyed) return@runOnUiThread
            if (getPermissionState("camera") == com.getcapacitor.PermissionState.GRANTED) {
                startPreviewInternal(call)
            } else {
                pendingPreviewCall = null
                call.reject("Camera permission denied", "CAMERA_PERMISSION_DENIED")
            }
        }
    }

    override fun hasRequiredPermissions(): Boolean {
        return getPermissionState("camera") == com.getcapacitor.PermissionState.GRANTED
    }

    private fun startPreviewInternal(call: PluginCall) {
        val direction = call.getString("direction") ?: "back"
        val resObj = call.getObject("resolution")
        val width = resObj?.getInteger("width") ?: 1920
        val height = resObj?.getInteger("height") ?: 1080
        val mirror = call.getBoolean("mirror") ?: (direction == "front")

        currentPreviewWidth = width
        currentPreviewHeight = height

        try {
            require(direction == "front" || direction == "back") { "Camera direction must be front or back" }
            require(width > 0 && height > 0) { "Preview dimensions must be positive" }
            cameraExecutor = Executors.newSingleThreadExecutor()

            val cameraProviderFuture = ProcessCameraProvider.getInstance(context)

            cameraProviderFuture.addListener({
                if (pendingPreviewCall !== call || destroyed) return@addListener
                try {
                    val provider = cameraProviderFuture.get()
                    cameraProvider = provider

                    previewView = androidx.camera.view.PreviewView(context).apply {
                        layoutParams = ViewGroup.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT
                        )
                        scaleType = androidx.camera.view.PreviewView.ScaleType.FILL_CENTER
                    }

                    if (mirror) {
                        previewView?.scaleX = -1f
                    }

                    // Insert preview behind the WebView.
                    val webView = requireNotNull(bridge.webView) { "Camera preview requires a WebView" }
                    val parent = requireNotNull(webView.parent as? ViewGroup) { "Camera preview requires an attached WebView" }
                    parent.addView(previewView, 0)
                    webView.setBackgroundColor(android.graphics.Color.TRANSPARENT)

                    val resolutionSelector = ResolutionSelector.Builder()
                        .setResolutionStrategy(
                            ResolutionStrategy(
                                Size(width, height),
                                ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER,
                            )
                        )
                        .build()

                    currentDirection = direction
                    currentCameraSelector = if (direction == "front") {
                        CameraSelector.DEFAULT_FRONT_CAMERA
                    } else {
                        CameraSelector.DEFAULT_BACK_CAMERA
                    }

                    val previewBuilder = Preview.Builder().setResolutionSelector(resolutionSelector)
                    observeCameraFrames(previewBuilder, previewEpoch)
                    preview = previewBuilder.build()
                        .also {
                            it.setSurfaceProvider(previewView?.surfaceProvider)
                        }

                    // Build ImageCapture with flash mode from current settings.
                    imageCapture = ImageCapture.Builder()
                        .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
                        .setResolutionSelector(resolutionSelector)
                        .setFlashMode(flashModeFromSetting(currentSettings["flash"] as? String ?: "off"))
                        .build()

                    val recorder = Recorder.Builder()
                        .setQualitySelector(QualitySelector.from(Quality.HIGHEST))
                        .build()
                    videoCapture = VideoCapture.withOutput(recorder)

                    provider.unbindAll()

                    camera = provider.bindToLifecycle(
                        activity as LifecycleOwner,
                        currentCameraSelector,
                        preview,
                        imageCapture,
                        videoCapture
                    )

                    restoreCameraSettings(requireNotNull(camera), {
                        if (pendingPreviewCall === call) {
                            pendingPreviewCall = null
                            call.resolve(JSObject().apply {
                                put("width", width)
                                put("height", height)
                                put("deviceId", if (direction == "front") "front" else "back")
                            })
                        }
                    }, { error -> failPreview(call, error) })
                } catch (error: Exception) {
                    // error-policy:J1 asynchronous preview failures settle the owning bridge call.
                    failPreview(call, error)
                }
            }, ContextCompat.getMainExecutor(context))
        } catch (error: Exception) {
            // error-policy:J1 synchronous provider/setup failures settle the owning bridge call.
            failPreview(call, error)
        }
    }

    private fun failPreview(call: PluginCall, error: Exception) {
        if (pendingPreviewCall !== call) return
        pendingPreviewCall = null
        stopPreviewInternal()
        notifyListeners("error", JSObject().apply {
            put("code", "PREVIEW_ERROR")
            put("message", "Failed to start preview: ${error.message}")
        })
        call.reject("Failed to start preview", "PREVIEW_ERROR", error)
    }

    @PluginMethod
    fun stopPreview(call: PluginCall) {
        activity.runOnUiThread {
            stopPreviewInternal()
            call.resolve()
        }
    }

    private fun stopPreviewInternal() {
        while (pendingCameraSwitches.isNotEmpty()) {
            pendingCameraSwitches.removeFirst().reject("Preview stopped before camera switch", "CAMERA_INACTIVE")
        }
        pendingPreviewCall?.reject("Preview was stopped before it started", "PREVIEW_CANCELLED")
        pendingPreviewCall = null
        previewEpoch++
        frameDelivery.removeCallbacksAndMessages(null)
        lastFrameEventNanos = 0L
        observedFocus = null

        recordingSession?.let { session ->
            session.stopping = true
            if (session.recording == null) finishRecording(session, null,
                java.util.concurrent.CancellationException("Preview stopped before recording started"))
            else session.recording?.stop()
        }

        cameraProvider?.unbindAll()
        cameraProvider = null

        previewView?.let { view ->
            (view.parent as? ViewGroup)?.removeView(view)
        }
        previewView = null

        cameraExecutor?.shutdown()
        cameraExecutor = null

        preview = null
        imageCapture = null
        videoCapture = null
        camera = null
    }

    // ---- Switch Camera ----

    @PluginMethod
    fun switchCamera(call: PluginCall) {
        activity.runOnUiThread {
            if (switchingCamera) {
                pendingCameraSwitches.addLast(call)
            } else {
                switchingCamera = true
                switchCameraNow(call)
            }
        }
    }

    private fun finishCameraSwitch() {
        val next = pendingCameraSwitches.pollFirst()
        if (next == null) switchingCamera = false
        else ContextCompat.getMainExecutor(context).execute { switchCameraNow(next) }
    }

    private fun switchCameraNow(call: PluginCall) {
        activity.runOnUiThread {
            if (pendingPreviewCall != null) {
                call.reject("Wait for camera preview to start", "CAMERA_NOT_READY")
                finishCameraSwitch()
                return@runOnUiThread
            }
            val provider = cameraProvider
            if (destroyed || provider == null) {
                call.reject("Preview not started", "CAMERA_NOT_READY")
                finishCameraSwitch()
                return@runOnUiThread
            }
            val direction = call.getString("direction")
                ?: if (currentCameraSelector == CameraSelector.DEFAULT_BACK_CAMERA) "front" else "back"
            if (direction != "front" && direction != "back") {
                call.reject("Camera direction must be front or back", "INVALID_OPTIONS")
                finishCameraSwitch()
                return@runOnUiThread
            }
            val mirror = direction == "front"
            if (recordingSession != null || recordingPermissionCalls.isNotEmpty()) {
                call.reject("Stop the recording before switching cameras", "RECORDING_BUSY")
                finishCameraSwitch()
                return@runOnUiThread
            }
            try {
                val targetSelector = if (direction == "front") CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA
                val targetInfo = targetSelector.filter(provider.availableCameraInfos).firstOrNull()
                val preset = currentSettings["whiteBalance"] as? String ?: "auto"
                if (targetInfo == null || !supportsWhiteBalance(targetInfo, preset)) {
                    call.reject("Target camera does not support white balance preset $preset", "WHITE_BALANCE_UNSUPPORTED")
                    finishCameraSwitch()
                    return@runOnUiThread
                }
                if (targetInfo.exposureState.isExposureCompensationSupported || requestedExposureEv != 0.0) {
                    planExposure(targetInfo, requestedExposureEv)
                }
                validateZoom(targetInfo, (currentSettings["zoom"] as? Number)?.toFloat() ?: 1.0f)
                validateFlash(targetInfo, currentSettings["flash"] as? String ?: "off")
                preflightFocus(targetInfo)
                currentDirection = direction
                currentCameraSelector = targetSelector

                previewView?.scaleX = if (mirror) -1f else 1f

                provider.unbindAll()

                camera = provider.bindToLifecycle(
                    activity as LifecycleOwner,
                    currentCameraSelector,
                    preview,
                    imageCapture,
                    videoCapture
                )

                restoreCameraSettings(requireNotNull(camera), {
                    call.resolve(JSObject().apply {
                        put("width", currentPreviewWidth)
                        put("height", currentPreviewHeight)
                        put("deviceId", direction)
                    })
                    finishCameraSwitch()
                }, { error ->
                    call.reject("Failed to restore camera settings", "SWITCH_CAMERA_ERROR", error)
                    finishCameraSwitch()
                })
            } catch (e: Exception) {
                // error-policy:J1 camera switching failures reject the bridge call.
                notifyListeners("error", JSObject().apply {
                    put("code", "SWITCH_CAMERA_ERROR")
                    put("message", "Failed to switch camera: ${e.message}")
                })
                call.reject("Failed to switch camera: ${e.message}", "SWITCH_CAMERA_ERROR", e)
                finishCameraSwitch()
            }
        }
    }

    // ---- Photo Capture ----

    @PluginMethod
    fun capturePhoto(call: PluginCall) {
        val imgCapture = this.imageCapture ?: run {
            call.reject("Camera not ready")
            return
        }

        val quality = call.getFloat("quality") ?: 90f
        val format = call.getString("format") ?: "jpeg"
        val saveToGallery = call.getBoolean("saveToGallery") ?: false
        val targetWidth = call.getInt("width")
        val targetHeight = call.getInt("height")
        val includeExif = call.getBoolean("exifOrientation") ?: false

        // Apply flash mode for this capture.
        val flashSetting = currentSettings["flash"] as? String ?: "off"
        imgCapture.flashMode = flashModeFromSetting(flashSetting)

        // Use file-based capture for EXIF support (matches classic CameraCaptureManager pattern).
        val tempFile = File.createTempFile("eliza-snap-", ".jpg", context.cacheDir)
        val outputOptions = ImageCapture.OutputFileOptions.Builder(tempFile).build()

        imgCapture.takePicture(
            outputOptions,
            cameraExecutor ?: Executors.newSingleThreadExecutor(),
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(outputFileResults: ImageCapture.OutputFileResults) {
                    try {
                        // Extract EXIF orientation before decoding.
                        val exif = ExifInterface(tempFile.absolutePath)
                        val orientation = exif.getAttributeInt(
                            ExifInterface.TAG_ORIENTATION,
                            ExifInterface.ORIENTATION_NORMAL
                        )

                        val bytes = tempFile.readBytes()
                        var bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                            ?: throw IllegalStateException("Failed to decode captured image")

                        // Rotate based on EXIF orientation (like classic implementation).
                        bitmap = rotateBitmapByExif(bitmap, orientation)

                        // Scale if target dimensions specified.
                        if (targetWidth != null && targetHeight != null) {
                            bitmap = Bitmap.createScaledBitmap(
                                bitmap, targetWidth, targetHeight, true
                            )
                        }

                        val outputStream = ByteArrayOutputStream()
                        val compressFormat = when (format) {
                            "png" -> Bitmap.CompressFormat.PNG
                            "webp" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                                Bitmap.CompressFormat.WEBP_LOSSY
                            } else {
                                @Suppress("DEPRECATION")
                                Bitmap.CompressFormat.WEBP
                            }
                            else -> Bitmap.CompressFormat.JPEG
                        }
                        bitmap.compress(compressFormat, quality.toInt(), outputStream)

                        val outputBytes = outputStream.toByteArray()
                        val base64 = Base64.encodeToString(outputBytes, Base64.NO_WRAP)

                        if (saveToGallery) {
                            saveImageToGallery(outputBytes, format)
                        }

                        // Build EXIF metadata if requested.
                        val exifData = if (includeExif) extractExifData(exif) else null

                        val finalWidth = bitmap.width
                        val finalHeight = bitmap.height
                        bitmap.recycle()

                        activity.runOnUiThread {
                            call.resolve(JSObject().apply {
                                put("base64", base64)
                                put("format", format)
                                put("width", finalWidth)
                                put("height", finalHeight)
                                exifData?.let { put("exif", it) }
                            })
                        }
                    } catch (e: Exception) {
                        // error-policy:J1 capture/encoding failures reject the bridge call.
                        call.reject("Photo processing failed: ${e.message}")
                    } finally {
                        tempFile.delete()
                    }
                }

                override fun onError(exception: ImageCaptureException) {
                    tempFile.delete()
                    notifyListeners("error", JSObject().apply {
                        put("code", "CAPTURE_ERROR")
                        put("message", "Photo capture failed: ${exception.message}")
                    })
                    call.reject("Photo capture failed: ${exception.message}")
                }
            }
        )
    }

    /** Rotate bitmap using EXIF orientation (ported from classic CameraCaptureManager). */
    private fun rotateBitmapByExif(bitmap: Bitmap, orientation: Int): Bitmap {
        val matrix = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
            ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
            ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.postScale(-1f, 1f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.postScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> {
                matrix.postRotate(90f)
                matrix.postScale(-1f, 1f)
            }
            ExifInterface.ORIENTATION_TRANSVERSE -> {
                matrix.postRotate(-90f)
                matrix.postScale(-1f, 1f)
            }
            else -> return bitmap
        }
        val rotated =
            Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
        if (rotated !== bitmap) {
            bitmap.recycle()
        }
        return rotated
    }

    /** Extract common EXIF tags as a JSObject. */
    private fun extractExifData(exif: ExifInterface): JSObject {
        return JSObject().apply {
            exif.getAttribute(ExifInterface.TAG_MAKE)?.let { put("Make", it) }
            exif.getAttribute(ExifInterface.TAG_MODEL)?.let { put("Model", it) }
            exif.getAttribute(ExifInterface.TAG_ORIENTATION)?.let { put("Orientation", it) }
            exif.getAttribute(ExifInterface.TAG_DATETIME)?.let { put("DateTime", it) }
            exif.getAttribute(ExifInterface.TAG_EXPOSURE_TIME)?.let { put("ExposureTime", it) }
            exif.getAttribute(ExifInterface.TAG_F_NUMBER)?.let { put("FNumber", it) }
            exif.getAttribute(ExifInterface.TAG_PHOTOGRAPHIC_SENSITIVITY)?.let {
                put("ISO", it)
            }
            exif.getAttribute(ExifInterface.TAG_FOCAL_LENGTH)?.let { put("FocalLength", it) }
            exif.getAttribute(ExifInterface.TAG_WHITE_BALANCE)?.let { put("WhiteBalance", it) }
            exif.getAttribute(ExifInterface.TAG_FLASH)?.let { put("Flash", it) }
            exif.getAttribute(ExifInterface.TAG_IMAGE_WIDTH)?.let { put("ImageWidth", it) }
            exif.getAttribute(ExifInterface.TAG_IMAGE_LENGTH)?.let { put("ImageLength", it) }
            exif.getAttribute(ExifInterface.TAG_GPS_LATITUDE)?.let { put("GPSLatitude", it) }
            exif.getAttribute(ExifInterface.TAG_GPS_LONGITUDE)?.let { put("GPSLongitude", it) }
        }
    }

    private fun saveImageToGallery(bytes: ByteArray, format: String) {
        val fileName =
            "IMG_${SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())}.$format"

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val contentValues = ContentValues().apply {
                put(MediaStore.Images.Media.DISPLAY_NAME, fileName)
                put(MediaStore.Images.Media.MIME_TYPE, "image/$format")
                put(
                    MediaStore.Images.Media.RELATIVE_PATH,
                    Environment.DIRECTORY_PICTURES
                )
            }
            val uri = context.contentResolver.insert(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI, contentValues
            )
            uri?.let {
                context.contentResolver.openOutputStream(it)?.use { outputStream ->
                    outputStream.write(bytes)
                }
            }
        } else {
            @Suppress("DEPRECATION")
            val picturesDir =
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES)
            val file = File(picturesDir, fileName)
            file.writeBytes(bytes)
        }
    }

    // ---- Video Recording ----

    @PluginMethod
    fun startRecording(call: PluginCall) {
        activity.runOnUiThread {
            if (destroyed) {
                call.reject("Camera plugin was destroyed", "CAMERA_DESTROYED")
            } else if (recordingSession != null || recordingPermissionCalls.isNotEmpty()) {
                call.reject("A recording is already starting, recording or finalizing", "RECORDING_BUSY")
            } else if (videoCapture == null) {
                call.reject("Camera not ready", "CAMERA_NOT_READY")
            } else if ((call.getBoolean("audio") ?: true) &&
                getPermissionState("microphone") != com.getcapacitor.PermissionState.GRANTED) {
                recordingPermissionCalls.add(call)
                requestPermissionForAlias("microphone", call, "handleMicPermissionForRecording")
            } else {
                startRecordingInternal(call)
            }
        }
    }

    @PermissionCallback
    private fun handleMicPermissionForRecording(call: PluginCall) {
        activity.runOnUiThread {
            if (!recordingPermissionCalls.remove(call)) return@runOnUiThread
            if (getPermissionState("microphone") != com.getcapacitor.PermissionState.GRANTED) {
                call.reject("Microphone permission denied for the requested audio recording", "MICROPHONE_DENIED")
            } else {
                startRecordingInternal(call)
            }
        }
    }

    @android.annotation.SuppressLint("MissingPermission")
    private fun startRecordingInternal(call: PluginCall) {
        if (destroyed || videoCapture == null) {
            call.reject("Camera is no longer available", "CAMERA_NOT_READY")
            return
        }
        if (recordingSession != null) {
            call.reject("A recording is still active or finalizing", "RECORDING_BUSY")
            return
        }
        val maxDuration: Double?
        val maxFileSize: Double?
        val bitrate: Double?
        val frameRate: Double?
        val quality: Quality
        try {
            maxDuration = positiveRecordingOption(call, "maxDuration", Long.MAX_VALUE.toDouble() / 1000, false)
            maxFileSize = positiveRecordingOption(call, "maxFileSize", Long.MAX_VALUE.toDouble(), true)
            bitrate = positiveRecordingOption(call, "bitrate", Int.MAX_VALUE.toDouble() + 1, true)
            frameRate = positiveRecordingOption(call, "frameRate", Int.MAX_VALUE.toDouble() + 1, true)
            quality = when (if (call.data.has("quality")) call.getString("quality") else "highest") {
                "low" -> Quality.SD
                "medium" -> Quality.HD
                "high" -> Quality.FHD
                "highest" -> Quality.HIGHEST
                else -> throw IllegalArgumentException("Unknown recording quality")
            }
        } catch (error: IllegalArgumentException) {
            // error-policy:J3 reject malformed recording options before native effects.
            call.reject(error.message, "INVALID_OPTIONS", error)
            return
        }
        val saveToGallery = call.getBoolean("saveToGallery") ?: false
        if (saveToGallery && Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.reject("Gallery recording requires Android 10 or newer", "GALLERY_UNAVAILABLE")
            return
        }
        val fileName = "VID_${UUID.randomUUID()}.mp4"
        val file = if (saveToGallery) null else File(context.cacheDir, fileName)
        val session = RecordingSession(call, file)
        recordingSession = session
        completedRecording = null
        completedRecordingError = null
        try {
            val selector = if (quality == Quality.HIGHEST) QualitySelector.from(quality)
                else QualitySelector.from(quality, FallbackStrategy.lowerQualityOrHigherThan(quality))
            val recorder = Recorder.Builder().setQualitySelector(selector)
            if (bitrate != null) recorder.setTargetVideoEncodingBitRate(bitrate.toInt())
            val captureBuilder = VideoCapture.Builder(recorder.build())
            if (frameRate != null) captureBuilder.setTargetFrameRate(Range(frameRate.toInt(), frameRate.toInt()))
            val capture = captureBuilder.build()
            val provider = requireNotNull(cameraProvider) { "Camera provider is unavailable" }
            provider.unbindAll()
            videoCapture = capture
            camera = provider.bindToLifecycle(activity as LifecycleOwner, currentCameraSelector,
                requireNotNull(preview), requireNotNull(imageCapture), capture)
            restoreCameraSettings(requireNotNull(camera), {
                check(recordingSession === session && !session.stopping) { "Recording was cancelled before native settings completed" }
                val pending = if (saveToGallery) {
                    val values = ContentValues().apply {
                        put(MediaStore.Video.Media.DISPLAY_NAME, fileName)
                        put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
                        put(MediaStore.Video.Media.RELATIVE_PATH, Environment.DIRECTORY_MOVIES)
                    }
                    val builder = MediaStoreOutputOptions.Builder(context.contentResolver, MediaStore.Video.Media.EXTERNAL_CONTENT_URI)
                        .setContentValues(values)
                    if (maxDuration != null) builder.setDurationLimitMillis((maxDuration * 1000).toLong().coerceAtLeast(1))
                    if (maxFileSize != null) builder.setFileSizeLimit(maxFileSize.toLong())
                    capture.output.prepareRecording(context, builder.build())
                } else {
                    val builder = FileOutputOptions.Builder(requireNotNull(file))
                    if (maxDuration != null) builder.setDurationLimitMillis((maxDuration * 1000).toLong().coerceAtLeast(1))
                    if (maxFileSize != null) builder.setFileSizeLimit(maxFileSize.toLong())
                    capture.output.prepareRecording(context, builder.build())
                }
                if (call.getBoolean("audio") ?: true) pending.withAudioEnabled()
                session.recording = pending.start(ContextCompat.getMainExecutor(context)) { event ->
                    if (recordingSession !== session) return@start
                    session.duration = event.recordingStats.recordedDurationNanos / 1_000_000_000.0
                    session.fileSize = event.recordingStats.numBytesRecorded
                    when (event) {
                        is VideoRecordEvent.Start -> {
                            session.started = true
                            session.startSettled = true
                            call.resolve()
                        }
                        is VideoRecordEvent.Finalize -> {
                            val acceptableLimit = event.error == VideoRecordEvent.Finalize.ERROR_DURATION_LIMIT_REACHED ||
                                event.error == VideoRecordEvent.Finalize.ERROR_FILE_SIZE_LIMIT_REACHED
                            try {
                                if (event.hasError() && !acceptableLimit) {
                                    throw IllegalStateException("CameraX could not finalize recording (code ${event.error})", event.cause)
                                }
                                val outputUri = event.outputResults.outputUri
                                val uri = if (outputUri != Uri.EMPTY) outputUri else Uri.fromFile(requireNotNull(session.file))
                                val outputBytes = session.file?.length()
                                    ?: context.contentResolver.openFileDescriptor(uri, "r")?.use { it.statSize }
                                    ?: throw IllegalStateException("Finalized video is not readable")
                                val metadata = MediaMetadataRetriever()
                                val result = try {
                                    metadata.setDataSource(context, uri)
                                    val width = metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull()
                                    val height = metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull()
                                    require(width != null && width > 0 && height != null && height > 0) { "Finalized video has no readable dimensions" }
                                    require(outputBytes > 0 && session.duration > 0) { "Finalized video contains no recorded media" }
                                    JSObject().apply {
                                        put("path", session.file?.absolutePath ?: uri.toString())
                                        put("duration", session.duration)
                                        put("width", width)
                                        put("height", height)
                                        put("fileSize", outputBytes)
                                        put("mimeType", "video/mp4")
                                    }
                                } finally {
                                    metadata.release()
                                }
                                finishRecording(session, result, null)
                            } catch (error: Exception) {
                                // error-policy:J1 CameraX/output failures become explicit bridge failures.
                                finishRecording(session, null, error)
                            }
                        }
                    }
                    notifyListeners("recordingState", JSObject().apply {
                        put("isRecording", recordingSession === session && session.started && !session.stopping)
                        put("duration", session.duration)
                        put("fileSize", session.fileSize)
                    })
                }
            }, { error ->
                if (recordingSession === session) {
                    finishRecording(session, null, error)
                    stopPreviewInternal()
                }
            })
        } catch (error: Exception) {
            // error-policy:J1 synchronous CameraX admission errors settle the owning call.
            finishRecording(session, null, error)
            stopPreviewInternal()
        }
    }

    private fun positiveRecordingOption(call: PluginCall, name: String, upperExclusive: Double, integer: Boolean): Double? {
        if (!call.data.has(name)) return null
        val value = (call.data.opt(name) as? Number)?.toDouble()
            ?: throw IllegalArgumentException("$name must be numeric")
        require(value.isFinite() && value > 0 && value < upperExclusive && (!integer || value % 1.0 == 0.0)) {
            "$name must be a positive finite ${if (integer) "integer" else "number"} within the native range"
        }
        return value
    }

    private fun finishRecording(session: RecordingSession, result: JSObject?, error: Exception?) {
        if (recordingSession !== session) return
        recordingSession = null
        if (!session.startSettled) {
            session.startSettled = true
            session.startCall.reject("Recording did not start", "RECORDING_ERROR", error)
        }
        if (session.stopCalls.isEmpty()) {
            completedRecording = result
            completedRecordingError = error
        } else {
            for (call in session.stopCalls) {
                if (error != null) call.reject("Recording could not be finalized", "RECORDING_ERROR", error)
                else call.resolve(requireNotNull(result))
            }
            session.stopCalls.clear()
        }
        if (error != null) notifyListeners("error", JSObject().apply {
            put("code", "RECORDING_ERROR")
            put("message", error.message)
        })
    }

    @PluginMethod
    fun stopRecording(call: PluginCall) {
        activity.runOnUiThread {
            val session = recordingSession
            if (session == null) {
                val result = completedRecording
                val error = completedRecordingError
                completedRecording = null
                completedRecordingError = null
                if (error != null) call.reject("Recording could not be finalized", "RECORDING_ERROR", error)
                else if (result != null) call.resolve(result)
                else call.reject("Not recording", "NOT_RECORDING")
                return@runOnUiThread
            }
            session.stopCalls.add(call)
            if (!session.stopping) {
                session.stopping = true
                if (session.recording == null) finishRecording(session, null,
                    java.util.concurrent.CancellationException("Recording stopped before native settings completed"))
                else session.recording?.stop()
            }
        }
    }

    @PluginMethod
    fun getRecordingState(call: PluginCall) {
        activity.runOnUiThread {
            val session = recordingSession
            call.resolve(JSObject().apply {
                put("isRecording", session != null && session.started && !session.stopping)
                put("duration", session?.duration ?: 0.0)
                put("fileSize", session?.fileSize ?: 0L)
            })
        }
    }

    // ---- Settings ----

    @PluginMethod
    fun getSettings(call: PluginCall) {
        call.resolve(JSObject().apply {
            put("settings", JSObject().apply {
                synchronized(currentSettings) {
                    currentSettings.forEach { (key, value) ->
                        when (value) {
                            is Float -> put(key, value.toDouble())
                            is Double -> put(key, value)
                            is Int -> put(key, value)
                            is String -> put(key, value)
                            is Boolean -> put(key, value)
                            else -> put(key, value.toString())
                        }
                    }
                }
            })
        })
    }

    @PluginMethod
    fun setSettings(call: PluginCall) {
        // Validate the whole batch before mutating cached state or native controls.
        // JSONObject getters coerce strings, which is not the bridge contract.
        val settings = call.data.opt("settings") as? org.json.JSONObject
        if (settings == null) {
            call.reject("settings must be an object", "INVALID_ARGUMENT")
            return
        }
        val error = validateSettings(settings)
        if (error != null) {
            call.reject(error, "INVALID_ARGUMENT")
            return
        }

        if (settings.has("whiteBalance") || settings.has("exposureCompensation") || settings.has("zoom") || settings.has("flash") || settings.has("focusMode")) {
            withActiveCamera(call) { owner ->
                val preset = if (settings.has("whiteBalance")) settings.getString("whiteBalance") else null
                if (preset != null && !supportsWhiteBalance(owner.cameraInfo, preset)) {
                    call.reject("This camera does not support white balance preset $preset", "WHITE_BALANCE_UNSUPPORTED")
                    return@withActiveCamera
                }
                val requestedEv = if (settings.has("exposureCompensation")) settings.getDouble("exposureCompensation") else null
                // Validate every native setting before submitting any part of the batch.
                val exposure = requestedEv?.let { planExposure(owner.cameraInfo, it) }
                val zoom = if (settings.has("zoom")) settings.getDouble("zoom").toFloat().also { validateZoom(owner.cameraInfo, it) } else null
                val flash = if (settings.has("flash")) settings.getString("flash").also { validateFlash(owner.cameraInfo, it) } else null
                val focus = if (settings.has("focusMode")) planFocus(owner.cameraInfo, settings.getString("focusMode")) else null
                val epoch = previewEpoch
                val failed: (Exception) -> Unit = { error -> call.reject("Camera control failed", "CAMERA_CONTROL_FAILED", error) }
                fun complete() {
                    applySettingsValues(settings)
                    call.resolve()
                }
                fun applyBatchFocus() {
                    if (focus == null) complete()
                    else applyFocus(owner, epoch, focus, {
                        confirmFocus(owner.cameraInfo, focus)
                        currentSettings["focusMode"] = focus.preset
                        complete()
                    }, failed)
                }
                fun applyBatchFlash() {
                    if (flash == null) applyBatchFocus()
                    else applyFlash(owner, epoch, flash, {
                        currentSettings["flash"] = flash
                        applyBatchFocus()
                    }, failed)
                }
                fun applyBatchZoom() {
                    if (zoom == null) applyBatchFlash()
                    else awaitCameraControl(owner, epoch, owner.cameraControl.setZoomRatio(zoom), {
                        currentSettings["zoom"] = zoom
                        applyBatchFlash()
                    }, failed)
                }
                fun applyExposure() {
                    if (exposure == null) applyBatchZoom()
                    else awaitCameraControl(owner, epoch, owner.cameraControl.setExposureCompensationIndex(exposure.index), {
                        requestedExposureEv = requireNotNull(requestedEv)
                        currentSettings["exposureCompensation"] = exposure.appliedEv
                        applyBatchZoom()
                    }, failed)
                }
                if (preset == null) applyExposure()
                else awaitCameraControl(owner, epoch, whiteBalanceFuture(owner, preset), {
                    currentSettings["whiteBalance"] = preset
                    applyExposure()
                }, failed)
            }
        } else {
            applySettingsValues(settings)
            call.resolve()
        }
    }

    private fun applySettingsValues(settings: org.json.JSONObject) {
        settings.keys().forEach { key ->
            if (key !in setOf("exposureCompensation", "zoom", "flash", "focusMode")) currentSettings[key] = settings.get(key)
        }

    }

    private fun validateSettings(settings: org.json.JSONObject): String? {
        for (key in settings.keys()) {
            val value = settings.opt(key)
            val valid = when (key) {
                "flash" -> value is String && value in setOf("off", "on", "auto", "torch")
                "focusMode", "exposureMode" -> value is String && value in setOf("auto", "continuous", "manual")
                "whiteBalance" -> value is String && value in setOf("auto", "daylight", "cloudy", "tungsten", "fluorescent")
                "zoom" -> value is Number && value.toFloat().isFinite() && value.toFloat() > 0f
                "exposureCompensation" -> value is Number && value.toFloat().isFinite()
                "iso" -> value is Number && value.toDouble().isFinite() &&
                    value.toDouble() in 1.0..Int.MAX_VALUE.toDouble() && value.toDouble() % 1.0 == 0.0
                "shutterSpeed" -> value is Number && value.toDouble().isFinite() &&
                    value.toDouble() >= 1e-9 && value.toDouble() < Long.MAX_VALUE.toDouble() / 1e9
                else -> return "Unknown camera setting: $key"
            }
            if (!valid) return "Invalid value for camera setting: $key"
        }
        return null
    }

    private fun whiteBalanceMode(preset: String): Int = when (preset) {
        "auto" -> CaptureRequest.CONTROL_AWB_MODE_AUTO
        "daylight" -> CaptureRequest.CONTROL_AWB_MODE_DAYLIGHT
        "cloudy" -> CaptureRequest.CONTROL_AWB_MODE_CLOUDY_DAYLIGHT
        "tungsten" -> CaptureRequest.CONTROL_AWB_MODE_INCANDESCENT
        "fluorescent" -> CaptureRequest.CONTROL_AWB_MODE_FLUORESCENT
        else -> throw IllegalArgumentException("Unknown white balance preset: $preset")
    }

    @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
    private fun supportsWhiteBalance(info: CameraInfo, preset: String): Boolean {
        val modes = Camera2CameraInfo.from(info)
            .getCameraCharacteristic(CameraCharacteristics.CONTROL_AWB_AVAILABLE_MODES) ?: intArrayOf()
        return whiteBalanceMode(preset) in modes
    }

    @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
    private fun whiteBalanceFuture(owner: Camera, preset: String): ListenableFuture<Void> {
        require(supportsWhiteBalance(owner.cameraInfo, preset)) { "This camera does not support white balance preset $preset" }
        whiteBalanceRequestId++
        return Camera2CameraControl.from(owner.cameraControl).addCaptureRequestOptions(
            CaptureRequestOptions.Builder().setCaptureRequestOption(CaptureRequest.CONTROL_AWB_MODE,
                whiteBalanceMode(preset)).build())
    }

    // Rebinding CameraX use cases must restore confirmed white balance, EV, zoom and flash before the
    // owning preview/switch/recording operation can report success.
    private fun restoreCameraSettings(owner: Camera, ready: () -> Unit, failed: (Exception) -> Unit) {
        val epoch = previewEpoch
        val preset = currentSettings["whiteBalance"] as? String ?: "auto"
        fun stillOwnsCamera() = !destroyed && camera === owner && previewEpoch == epoch
        fun apply(allowRebindRetry: Boolean) {
            try {
                val future = whiteBalanceFuture(owner, preset)
                val requestId = whiteBalanceRequestId
                future.addListener({
                    try {
                        future.get()
                        check(stillOwnsCamera()) { "Camera changed during white balance restoration" }
                        restoreExposure(owner, epoch, {
                            val zoom = (currentSettings["zoom"] as? Number)?.toFloat() ?: 1.0f
                            validateZoom(owner.cameraInfo, zoom)
                            awaitCameraControl(owner, epoch, owner.cameraControl.setZoomRatio(zoom), {
                                applyFlash(owner, epoch, currentSettings["flash"] as? String ?: "off", {
                                    val focus = restoredFocus(owner.cameraInfo)
                                    applyFocus(owner, epoch, focus, {
                                        if (confirmedFocus != null) confirmFocus(owner.cameraInfo, focus)
                                        currentSettings["focusMode"] = focus.preset
                                        ready()
                                    }, failed)
                                }, failed)
                            }, failed)
                        }, failed)
                    } catch (error: Exception) {
                        // Unbind/rebind queues an inactive transition on CameraX's
                        // executor. Re-submit once after that transition, only if
                        // this request still owns the foreground camera. A newer
                        // preset, stop or switch must never be overwritten.
                        val cause = (error as? java.util.concurrent.ExecutionException)?.cause
                        val foreground = (activity as? LifecycleOwner)?.lifecycle?.currentState
                            ?.isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED) == true
                        if (allowRebindRetry && cause is CameraControl.OperationCanceledException &&
                            stillOwnsCamera() && whiteBalanceRequestId == requestId && foreground) {
                            apply(false)
                        } else failed(error)
                    }
                }, ContextCompat.getMainExecutor(context))
            } catch (error: Exception) {
                failed(error)
            }
        }
        apply(true)
    }

    @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
    private fun planFocus(info: CameraInfo, preset: String): FocusSetting {
        val mode = when(preset) {
            "manual" -> CaptureRequest.CONTROL_AF_MODE_OFF
            "auto" -> CaptureRequest.CONTROL_AF_MODE_AUTO
            else -> CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE
        }
        val details = Camera2CameraInfo.from(info)
        validateFocus(info, FocusSetting(preset, mode, null))
        val distance = if (preset != "manual") null else {
            val maximum = details.getCameraCharacteristic(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE)
            if (maximum == 0f) 0f else observedFocus?.takeIf { it.cameraId == details.cameraId }?.distance
                ?: throw CameraSettingException("CAMERA_NOT_READY", "A completed focus-distance capture is required before locking focus")
        }
        return FocusSetting(preset, mode, distance).also { validateFocus(info, it) }
    }

    @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
    private fun confirmFocus(info: CameraInfo, focus: FocusSetting) {
        confirmedFocus = focus
        if (focus.preset == "manual") {
            manualFocusDistances[Camera2CameraInfo.from(info).cameraId] = requireNotNull(focus.distance)
        } else manualFocusDistances.clear()
    }

    @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
    private fun preflightFocus(info: CameraInfo) {
        val focus = confirmedFocus ?: return
        // A manual lock belongs to its lens, not every camera on the device.
        val target = if (focus.preset == "manual") focus.copy(distance = manualFocusDistances[Camera2CameraInfo.from(info).cameraId]) else focus
        validateFocus(info, target)
    }

    @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
    private fun restoredFocus(info: CameraInfo): FocusSetting {
        val focus = confirmedFocus ?: return defaultFocus(info)
        if (focus.preset != "manual") return focus
        val stored = manualFocusDistances[Camera2CameraInfo.from(info).cameraId]
        return if (stored == null) planFocus(info, "manual") else focus.copy(distance = stored)
    }

    @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
    private fun defaultFocus(info: CameraInfo): FocusSetting {
        val modes = Camera2CameraInfo.from(info).getCameraCharacteristic(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES) ?: intArrayOf()
        return when {
            CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE in modes -> FocusSetting("continuous", CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE, null)
            CaptureRequest.CONTROL_AF_MODE_AUTO in modes -> FocusSetting("auto", CaptureRequest.CONTROL_AF_MODE_AUTO, null)
            else -> FocusSetting("manual", CaptureRequest.CONTROL_AF_MODE_OFF, 0f)
        }
    }

    @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
    private fun validateFocus(info: CameraInfo, focus: FocusSetting) {
        val details = Camera2CameraInfo.from(info)
        val modes = details.getCameraCharacteristic(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES) ?: intArrayOf()
        if (focus.mode !in modes || (focus.preset == "auto" && !info.isFocusMeteringSupported(centerFocusAction()))) {
            throw CameraSettingException("FOCUS_UNSUPPORTED", "This camera does not support ${focus.preset} focus")
        }
        focus.distance?.let { distance ->
            val maximum = details.getCameraCharacteristic(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE) ?: 0f
            if (!distance.isFinite() || distance < 0f || distance > maximum) {
                throw CameraSettingException("FOCUS_OUT_OF_RANGE", "Confirmed focus distance is outside this camera's supported range")
            }
        }
    }

    @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
    private fun centerFocusAction() = FocusMeteringAction.Builder(
        SurfaceOrientedMeteringPointFactory(1f, 1f).createPoint(0.5f, 0.5f), FocusMeteringAction.FLAG_AF)
        .setAutoCancelDuration(10, java.util.concurrent.TimeUnit.SECONDS).build()

    @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
    private fun applyFocus(owner: Camera, epoch: Long, focus: FocusSetting, ready: () -> Unit, failed: (Exception) -> Unit, triggerAuto: Boolean = true) {
        validateFocus(owner.cameraInfo, focus)
        val requestId = ++focusRequestId
        val options = CaptureRequestOptions.Builder()
            .setCaptureRequestOption(CaptureRequest.CONTROL_AF_MODE, focus.mode)
            .setCaptureRequestOption(CaptureRequest.LENS_FOCUS_DISTANCE, focus.distance ?: 0f).build()
        // CameraX cancellation waits for its default AF mode in a capture.
        // Release only our AF override first; keeping it would prevent that
        // future from completing. Preserve white balance and other interop keys.
        val interop = Camera2CameraControl.from(owner.cameraControl)
        val released = CaptureRequestOptions.Builder.from(interop.captureRequestOptions)
            .clearCaptureRequestOption(CaptureRequest.CONTROL_AF_MODE).build()
        awaitCameraControl(owner, epoch, interop.setCaptureRequestOptions(released), {
            check(requestId == focusRequestId) { "A newer focus request superseded this release" }
            awaitCameraControl(owner, epoch, owner.cameraControl.cancelFocusAndMetering(), {
                check(requestId == focusRequestId) { "A newer focus request superseded this reset" }
                awaitCameraControl(owner, epoch, interop.addCaptureRequestOptions(options), {
                    check(requestId == focusRequestId) { "A newer focus request superseded this mode" }
                    if (focus.preset == "auto" && triggerAuto) {
                        awaitCameraControl(owner, epoch, owner.cameraControl.startFocusAndMetering(centerFocusAction()), {
                            check(requestId == focusRequestId) { "A newer focus request superseded this autofocus operation" }
                            ready()
                        }, failed)
                    } else ready()
                }, failed)
            }, failed)
        }, failed)
    }

    // ---- Zoom ----

    @PluginMethod
    fun setZoom(call: PluginCall) {
        val zoom = (call.data.opt("zoom") as? Number)?.toFloat()
        if (zoom == null || !zoom.isFinite() || zoom <= 0f) {
            call.reject("zoom must be a positive finite number", "INVALID_ARGUMENT")
            return
        }
        withActiveCamera(call) { owner ->
            validateZoom(owner.cameraInfo, zoom)
            settleCameraControl(call, owner, owner.cameraControl.setZoomRatio(zoom)) {
                currentSettings["zoom"] = zoom
            }
        }
    }

    private fun validateZoom(info: CameraInfo, zoom: Float) {
        val bounds = info.zoomState.value
        if (bounds == null || zoom < bounds.minZoomRatio || zoom > bounds.maxZoomRatio) {
            throw CameraSettingException("ZOOM_OUT_OF_RANGE", "zoom is outside this camera's supported ratio range")
        }
    }

    @PluginMethod
    fun setFocusPoint(call: PluginCall) {
        setMeteringPoint(call, FocusMeteringAction.FLAG_AF, "focusMode")
    }

    @PluginMethod
    fun setExposurePoint(call: PluginCall) {
        setMeteringPoint(call, FocusMeteringAction.FLAG_AE, "exposureMode")
    }

    private fun setMeteringPoint(call: PluginCall, flag: Int, setting: String) {
        val x = (call.data.opt("x") as? Number)?.toDouble()
        val y = (call.data.opt("y") as? Number)?.toDouble()
        if (x == null || y == null || !x.isFinite() || !y.isFinite() || x !in 0.0..1.0 || y !in 0.0..1.0) {
            call.reject("x and y must be finite numbers between 0 and 1", "INVALID_ARGUMENT")
            return
        }
        withActiveCamera(call) { owner ->
            val view = previewView
            if (view == null || view.width <= 0 || view.height <= 0) {
                call.reject("Camera preview has no metering surface", "CAMERA_NOT_READY")
                return@withActiveCamera
            }
            val point = view.meteringPointFactory.createPoint((x * view.width).toFloat(), (y * view.height).toFloat())
            // Give CameraX's autofocus completion deadline room to settle before
            // automatic metering cancellation; three seconds cancelled pending AF.
            val action = FocusMeteringAction.Builder(point, flag)
                .setAutoCancelDuration(10, java.util.concurrent.TimeUnit.SECONDS).build()
            if (!owner.cameraInfo.isFocusMeteringSupported(action)) {
                call.reject("This camera does not support the requested metering operation", "METERING_UNSUPPORTED")
                return@withActiveCamera
            }
            if (flag == FocusMeteringAction.FLAG_AF) {
                val focus = planFocus(owner.cameraInfo, "auto")
                val epoch = previewEpoch
                val failed: (Exception) -> Unit = { error -> call.reject("Camera focus failed", "CAMERA_CONTROL_FAILED", error) }
                applyFocus(owner, epoch, focus, {
                    val requestId = focusRequestId
                    awaitCameraControl(owner, epoch, owner.cameraControl.startFocusAndMetering(action), {
                        check(requestId == focusRequestId) { "A newer focus request superseded this metering operation" }
                        confirmFocus(owner.cameraInfo, focus)
                        currentSettings[setting] = "auto"
                        call.resolve()
                    }, failed)
                }, failed, triggerAuto = false)
            } else settleCameraControl(call, owner, owner.cameraControl.startFocusAndMetering(action)) {
                currentSettings[setting] = "manual"
            }
        }
    }

    private fun withActiveCamera(call: PluginCall, operation: (Camera) -> Unit) {
        val host = activity
        if (host == null) {
            call.reject("Camera preview is not active", "CAMERA_INACTIVE")
            return
        }
        host.runOnUiThread {
            val owner = camera
            if (owner == null || destroyed) {
                call.reject("Camera preview is not active", "CAMERA_INACTIVE")
                return@runOnUiThread
            }
            if (pendingPreviewCall != null || switchingCamera || recordingSession?.let { !it.started && !it.stopping } == true) {
                call.reject("Camera settings are being restored", "CAMERA_NOT_READY")
                return@runOnUiThread
            }
            try {
                operation(owner)
            } catch (error: CameraSettingException) {
                call.reject(error.message, error.code, error)
            } catch (error: Exception) {
                call.reject("Camera control failed", "CAMERA_CONTROL_FAILED", error)
            }
        }
    }

    private fun settleCameraControl(call: PluginCall, owner: Camera, future: ListenableFuture<*>, onSuccess: () -> Unit) {
        awaitCameraControl(owner, previewEpoch, future, {
            onSuccess()
            call.resolve()
        }, { error -> call.reject("Camera control failed", "CAMERA_CONTROL_FAILED", error) })
    }

    private fun awaitCameraControl(owner: Camera, epoch: Long, future: ListenableFuture<*>, ready: () -> Unit, failed: (Exception) -> Unit) {
        future.addListener({
            try {
                future.get()
                check(!destroyed && camera === owner && previewEpoch == epoch) { "Camera changed before control completed" }
                ready()
            } catch (error: Exception) {
                failed(error)
            }
        }, ContextCompat.getMainExecutor(context))
    }

    private class CameraSettingException(val code: String, message: String) : IllegalArgumentException(message)
    private data class ExposureSetting(val index: Int, val appliedEv: Double)

    private fun planExposure(info: CameraInfo, ev: Double): ExposureSetting {
        val state = info.exposureState
        val step = state.exposureCompensationStep.toDouble()
        if (!state.isExposureCompensationSupported || !step.isFinite() || step <= 0.0) {
            throw CameraSettingException("EXPOSURE_UNSUPPORTED", "This camera does not support exposure compensation")
        }
        val range = state.exposureCompensationRange
        val minimum = range.lower * step
        val maximum = range.upper * step
        if (ev < minimum || ev > maximum) {
            throw CameraSettingException("EXPOSURE_OUT_OF_RANGE", "Exposure compensation must be between $minimum and $maximum EV")
        }
        val index = (ev / step).roundToInt()
        return ExposureSetting(index, index * step)
    }

    private fun restoreExposure(owner: Camera, epoch: Long, ready: () -> Unit, failed: (Exception) -> Unit) {
        // Zero is the default on cameras without adjustable compensation. This
        // does not turn an explicit unsupported user request into success.
        if (!owner.cameraInfo.exposureState.isExposureCompensationSupported && requestedExposureEv == 0.0) {
            currentSettings["exposureCompensation"] = 0.0
            ready()
            return
        }
        val exposure = planExposure(owner.cameraInfo, requestedExposureEv)
        awaitCameraControl(owner, epoch, owner.cameraControl.setExposureCompensationIndex(exposure.index), {
            currentSettings["exposureCompensation"] = exposure.appliedEv
            ready()
        }, failed)
    }

    // ---- Flash / Torch ----

    private fun flashModeFromSetting(setting: String): Int {
        return when (setting) {
            "auto" -> ImageCapture.FLASH_MODE_AUTO
            "on" -> ImageCapture.FLASH_MODE_ON
            "torch" -> ImageCapture.FLASH_MODE_OFF // Torch is handled separately.
            else -> ImageCapture.FLASH_MODE_OFF
        }
    }

    private fun validateFlash(info: CameraInfo, mode: String) {
        if (mode != "off" && !info.hasFlashUnit()) {
            throw CameraSettingException("FLASH_UNSUPPORTED", "This camera has no flash unit")
        }
    }

    @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
    private fun applyFlash(owner: Camera, epoch: Long, mode: String, ready: () -> Unit, failed: (Exception) -> Unit) {
        validateFlash(owner.cameraInfo, mode)
        requireNotNull(imageCapture) { "Camera capture is not ready" }.flashMode = flashModeFromSetting(mode)
        fun confirmCaptureOptions() {
            // ImageCapture's flash policy setter has no public future. A subsequent
            // Camera2 options update completes only after its session tag reaches a
            // capture, including the flash policy queued before it. Empty options
            // preserve existing interop settings such as white balance.
            awaitCameraControl(owner, epoch, Camera2CameraControl.from(owner.cameraControl)
                .addCaptureRequestOptions(CaptureRequestOptions.Builder().build()), ready, failed)
        }
        // CameraX rejects even disableTorch on a camera without a flash unit.
        if (!owner.cameraInfo.hasFlashUnit()) confirmCaptureOptions()
        else awaitCameraControl(owner, epoch, owner.cameraControl.enableTorch(mode == "torch"), {
            confirmCaptureOptions()
        }, failed)
    }

    // Capture completion supplies real frame evidence without binding an extra analysis stream.
    @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
    private fun observeCameraFrames(builder: Preview.Builder, epoch: Long) {
        Camera2Interop.Extender(builder).setSessionCaptureCallback(object : CameraCaptureSession.CaptureCallback() {
            override fun onCaptureCompleted(session: CameraCaptureSession, request: CaptureRequest, result: TotalCaptureResult) {
                val completedAt = System.currentTimeMillis()
                frameDelivery.post {
                    if (epoch != previewEpoch || destroyed) return@post
                    val owner = camera ?: return@post
                    if (Camera2CameraInfo.from(owner.cameraInfo).cameraId != session.device.id) return@post
                    result.get(CaptureResult.LENS_FOCUS_DISTANCE)?.let { distance ->
                        if (distance.isFinite()) observedFocus = FocusObservation(session.device.id, distance)
                    }
                    if (!hasListeners("frame")) return@post
                    val resolution = preview?.resolutionInfo?.resolution ?: return@post
                    val now = SystemClock.elapsedRealtimeNanos()
                    // Preserve the existing sampled notification rate; every notification
                    // is now driven by a completed camera capture, including after resume.
                    if (lastFrameEventNanos != 0L && now - lastFrameEventNanos < 500_000_000L) return@post
                    lastFrameEventNanos = now
                    notifyListeners("frame", JSObject().apply {
                        put("timestamp", completedAt)
                        put("width", resolution.width)
                        put("height", resolution.height)
                    })
                }
            }
        })
    }

    // ---- Permissions ----

    @PluginMethod
    override fun checkPermissions(call: PluginCall) {
        val cameraStatus = getPermissionState("camera")
        val micStatus = getPermissionState("microphone")

        call.resolve(JSObject().apply {
            put("camera", permissionString(cameraStatus))
            put("microphone", permissionString(micStatus))
            put("photos", "granted")
        })
    }

    @PluginMethod
    override fun requestPermissions(call: PluginCall) {
        requestAllPermissions(call, "handleAllPermissionsResult")
    }

    @PermissionCallback
    private fun handleAllPermissionsResult(call: PluginCall) {
        val cameraStatus = getPermissionState("camera")
        val micStatus = getPermissionState("microphone")

        call.resolve(JSObject().apply {
            put("camera", permissionString(cameraStatus))
            put("microphone", permissionString(micStatus))
            put("photos", "granted")
        })
    }

    private fun permissionString(status: com.getcapacitor.PermissionState?): String {
        return when (status) {
            com.getcapacitor.PermissionState.GRANTED -> "granted"
            com.getcapacitor.PermissionState.DENIED -> "denied"
            else -> "prompt"
        }
    }

    // ---- Lifecycle ----

    override fun handleOnDestroy() {
        activity.runOnUiThread {
            destroyed = true
            for (call in recordingPermissionCalls) call.reject("Camera plugin was destroyed", "CAMERA_DESTROYED")
            recordingPermissionCalls.clear()
            recordingSession?.let { session ->
                session.recording?.close()
                finishRecording(session, null, IllegalStateException("Camera plugin was destroyed"))
            }
            stopPreviewInternal()
        }
        super.handleOnDestroy()
    }
}
