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
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraCaptureSession
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

                    // Apply stored torch setting.
                    applyTorch(currentSettings["flash"] as? String == "torch")

                    pendingPreviewCall = null
                    call.resolve(JSObject().apply {
                        put("width", width)
                        put("height", height)
                        put("deviceId", if (direction == "front") "front" else "back")
                    })
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
        pendingPreviewCall?.reject("Preview was stopped before it started", "PREVIEW_CANCELLED")
        pendingPreviewCall = null
        previewEpoch++
        frameDelivery.removeCallbacksAndMessages(null)
        lastFrameEventNanos = 0L

        recordingSession?.let { session ->
            session.stopping = true
            session.recording?.stop()
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
            val provider = cameraProvider
            if (destroyed || provider == null) {
                call.reject("Preview not started", "CAMERA_NOT_READY")
                return@runOnUiThread
            }
            val direction = call.getString("direction")
                ?: if (currentCameraSelector == CameraSelector.DEFAULT_BACK_CAMERA) "front" else "back"
            if (direction != "front" && direction != "back") {
                call.reject("Camera direction must be front or back", "INVALID_OPTIONS")
                return@runOnUiThread
            }
            val mirror = direction == "front"
            if (recordingSession != null || recordingPermissionCalls.isNotEmpty()) {
                call.reject("Stop the recording before switching cameras", "RECORDING_BUSY")
                return@runOnUiThread
            }
            currentDirection = direction
            currentCameraSelector = if (direction == "front") {
                CameraSelector.DEFAULT_FRONT_CAMERA
            } else {
                CameraSelector.DEFAULT_BACK_CAMERA
            }

            previewView?.scaleX = if (mirror) -1f else 1f

            provider.unbindAll()

            try {
                camera = provider.bindToLifecycle(
                    activity as LifecycleOwner,
                    currentCameraSelector,
                    preview,
                    imageCapture,
                    videoCapture
                )

                // Re-apply settings after rebinding.
                applyTorch(currentSettings["flash"] as? String == "torch")
                applyZoom((currentSettings["zoom"] as? Number)?.toFloat() ?: 1.0f)

                call.resolve(JSObject().apply {
                    put("width", currentPreviewWidth)
                    put("height", currentPreviewHeight)
                    put("deviceId", direction)
                })
            } catch (e: Exception) {
                // error-policy:J1 camera switching failures reject the bridge call.
                notifyListeners("error", JSObject().apply {
                    put("code", "SWITCH_CAMERA_ERROR")
                    put("message", "Failed to switch camera: ${e.message}")
                })
                call.reject("Failed to switch camera: ${e.message}")
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
            applyTorch(currentSettings["flash"] as? String == "torch")
            applyZoom((currentSettings["zoom"] as? Number)?.toFloat() ?: 1.0f)
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
                session.recording?.stop()
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

        settings.keys().forEach { key ->
            currentSettings[key] = settings.get(key)
        }

        // Apply flash/torch setting.
        if (settings.has("flash")) {
            val flashMode = settings.getString("flash") ?: "off"
            currentSettings["flash"] = flashMode

            // Torch mode is handled via camera control, flash via ImageCapture.
            if (flashMode == "torch") {
                applyTorch(true)
            } else {
                applyTorch(false)
                imageCapture?.flashMode = flashModeFromSetting(flashMode)
            }
        }

        // Apply zoom.
        if (settings.has("zoom")) {
            val zoom = settings.getDouble("zoom").toFloat()
            applyZoom(zoom)
            currentSettings["zoom"] = zoom
        }

        // Apply exposure compensation.
        if (settings.has("exposureCompensation")) {
            val ev = settings.getDouble("exposureCompensation").toFloat()
            applyExposureCompensation(ev)
            currentSettings["exposureCompensation"] = ev
        }

        call.resolve()
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

    // ---- Zoom ----

    @PluginMethod
    fun setZoom(call: PluginCall) {
        val zoom = (call.data.opt("zoom") as? Number)?.toFloat()
        if (zoom == null || !zoom.isFinite() || zoom <= 0f) {
            call.reject("zoom must be a positive finite number", "INVALID_ARGUMENT")
            return
        }
        withActiveCamera(call) { owner ->
            val bounds = owner.cameraInfo.zoomState.value
            if (bounds == null || zoom < bounds.minZoomRatio || zoom > bounds.maxZoomRatio) {
                call.reject("zoom is outside this camera's supported ratio range", "ZOOM_OUT_OF_RANGE")
            } else {
                settleCameraControl(call, owner, owner.cameraControl.setZoomRatio(zoom)) {
                    currentSettings["zoom"] = zoom
                }
            }
        }
    }

    private fun applyZoom(zoom: Float) {
        val owner = camera ?: return
        val bounds = owner.cameraInfo.zoomState.value ?: return
        // The public API specifies a ratio; CameraX linear zoom is not linear in ratio.
        owner.cameraControl.setZoomRatio(zoom.coerceIn(bounds.minZoomRatio, bounds.maxZoomRatio))
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
            settleCameraControl(call, owner, owner.cameraControl.startFocusAndMetering(action)) {
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
            try {
                operation(owner)
            } catch (error: Exception) {
                call.reject("Camera control failed", "CAMERA_CONTROL_FAILED", error)
            }
        }
    }

    private fun settleCameraControl(call: PluginCall, owner: Camera, future: ListenableFuture<*>, onSuccess: () -> Unit) {
        val epoch = previewEpoch
        future.addListener({
            try {
                future.get()
                if (destroyed || camera !== owner || previewEpoch != epoch) {
                    call.reject("Camera preview changed before control completed", "CAMERA_INACTIVE")
                } else {
                    onSuccess()
                    call.resolve()
                }
            } catch (error: Exception) {
                call.reject("Camera control failed", "CAMERA_CONTROL_FAILED", error)
            }
        }, ContextCompat.getMainExecutor(context))
    }

    private fun applyExposureCompensation(ev: Float) {
        // CameraX exposure compensation uses an index. Map EV to the nearest index.
        val cameraInfo = camera?.cameraInfo ?: return
        val range = cameraInfo.exposureState.exposureCompensationRange
        val step = cameraInfo.exposureState.exposureCompensationStep.toFloat()
        if (step <= 0f) return
        val index = (ev / step).toInt().coerceIn(range.lower, range.upper)
        camera?.cameraControl?.setExposureCompensationIndex(index)
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

    private fun applyTorch(enabled: Boolean) {
        camera?.cameraControl?.enableTorch(enabled)
    }

    // Capture completion supplies real frame evidence without binding an extra analysis stream.
    @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
    private fun observeCameraFrames(builder: Preview.Builder, epoch: Long) {
        Camera2Interop.Extender(builder).setSessionCaptureCallback(object : CameraCaptureSession.CaptureCallback() {
            override fun onCaptureCompleted(session: CameraCaptureSession, request: CaptureRequest, result: TotalCaptureResult) {
                val completedAt = System.currentTimeMillis()
                frameDelivery.post {
                    if (epoch != previewEpoch || destroyed || !hasListeners("frame")) return@post
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
