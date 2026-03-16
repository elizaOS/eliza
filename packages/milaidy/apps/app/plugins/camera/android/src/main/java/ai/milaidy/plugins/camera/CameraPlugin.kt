package ai.milaidy.plugins.camera

import android.Manifest
import android.content.ContentValues
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Base64
import android.util.Size
import android.view.ViewGroup
import android.webkit.WebView
import androidx.camera.core.*
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.*
import androidx.core.content.ContextCompat
import androidx.exifinterface.media.ExifInterface
import androidx.lifecycle.LifecycleOwner
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import kotlinx.coroutines.*
import java.io.ByteArrayOutputStream
import java.io.File
import java.text.SimpleDateFormat
import java.util.*
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

@CapacitorPlugin(
    name = "MilaidyCamera",
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
    private var currentRecording: Recording? = null
    private var isRecording = false
    private var recordingStartTime = 0L
    private var recordingTimer: Handler? = null
    private var recordingRunnable: Runnable? = null
    private var currentCameraSelector = CameraSelector.DEFAULT_BACK_CAMERA
    private var currentDirection = "back"
    private var pendingCall: PluginCall? = null
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    // Frame event timer for emitting periodic frame events during preview.
    private var frameTimer: Handler? = null
    private var frameRunnable: Runnable? = null
    private var frameCount = 0L

    // Current recording output file (for returning path on stop).
    private var currentRecordingFile: File? = null
    private var currentRecordingSaveToGallery = false

    // Track current preview resolution for reference.
    private var currentPreviewWidth = 1920
    private var currentPreviewHeight = 1080

    private var currentSettings = mutableMapOf<String, Any>(
        "flash" to "off",
        "zoom" to 1.0f,
        "focusMode" to "continuous",
        "exposureMode" to "continuous",
        "exposureCompensation" to 0f,
        "whiteBalance" to "auto"
    )

    // ---- Device Enumeration ----

    @PluginMethod
    fun getDevices(call: PluginCall) {
        try {
            val cameraManager =
                context.getSystemService(android.content.Context.CAMERA_SERVICE) as CameraManager
            val devices = JSArray()

            for (cameraId in cameraManager.cameraIdList) {
                val characteristics = cameraManager.getCameraCharacteristics(cameraId)
                val facing = characteristics.get(CameraCharacteristics.LENS_FACING)

                val direction = when (facing) {
                    CameraCharacteristics.LENS_FACING_FRONT -> "front"
                    CameraCharacteristics.LENS_FACING_BACK -> "back"
                    else -> "external"
                }

                val hasFlash =
                    characteristics.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) ?: false
                val maxZoom =
                    characteristics.get(CameraCharacteristics.SCALER_AVAILABLE_MAX_DIGITAL_ZOOM)
                        ?: 1f

                val streamConfigMap =
                    characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
                val outputSizes =
                    streamConfigMap?.getOutputSizes(android.graphics.ImageFormat.JPEG) ?: arrayOf()

                val resolutions = JSArray()
                outputSizes.take(10).forEach { size ->
                    resolutions.put(JSObject().apply {
                        put("width", size.width)
                        put("height", size.height)
                    })
                }

                val fpsRanges =
                    characteristics.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)
                val frameRates = JSArray()
                val rateSet = mutableSetOf<Int>()
                fpsRanges?.forEach { range -> rateSet.add(range.upper) }
                rateSet.sortedDescending().forEach { frameRates.put(it) }

                devices.put(JSObject().apply {
                    put("deviceId", cameraId)
                    put("label", "Camera $cameraId ($direction)")
                    put("direction", direction)
                    put("hasFlash", hasFlash)
                    put("hasZoom", true)
                    put("maxZoom", maxZoom.toDouble())
                    put("supportedResolutions", resolutions)
                    put("supportedFrameRates", frameRates)
                })
            }

            call.resolve(JSObject().apply {
                put("devices", devices)
            })
        } catch (e: Exception) {
            call.reject("Failed to enumerate cameras: ${e.message}")
        }
    }

    // ---- Preview Lifecycle ----

    @PluginMethod
    fun startPreview(call: PluginCall) {
        if (!hasRequiredPermissions()) {
            pendingCall = call
            requestPermissionForAlias("camera", call, "handleCameraPermissionResult")
            return
        }
        startPreviewInternal(call)
    }

    @PermissionCallback
    private fun handleCameraPermissionResult(call: PluginCall) {
        if (getPermissionState("camera") == com.getcapacitor.PermissionState.GRANTED) {
            startPreviewInternal(call)
        } else {
            call.reject("Camera permission denied")
        }
    }

    private fun hasRequiredPermissions(): Boolean {
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

        activity.runOnUiThread {
            stopPreviewInternal()

            cameraExecutor = Executors.newSingleThreadExecutor()

            val cameraProviderFuture = ProcessCameraProvider.getInstance(context)

            cameraProviderFuture.addListener({
                try {
                    cameraProvider = cameraProviderFuture.get()

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
                    val webView = bridge.webView as? WebView
                    val parent = webView?.parent as? ViewGroup
                    parent?.let { viewGroup ->
                        viewGroup.addView(previewView, 0)
                        webView.setBackgroundColor(android.graphics.Color.TRANSPARENT)
                    }

                    currentDirection = direction
                    currentCameraSelector = if (direction == "front") {
                        CameraSelector.DEFAULT_FRONT_CAMERA
                    } else {
                        CameraSelector.DEFAULT_BACK_CAMERA
                    }

                    preview = Preview.Builder()
                        .setTargetResolution(Size(width, height))
                        .build()
                        .also {
                            it.surfaceProvider = previewView?.surfaceProvider
                        }

                    // Build ImageCapture with flash mode from current settings.
                    imageCapture = ImageCapture.Builder()
                        .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
                        .setTargetResolution(Size(width, height))
                        .setFlashMode(flashModeFromSetting(currentSettings["flash"] as? String ?: "off"))
                        .build()

                    val recorder = Recorder.Builder()
                        .setQualitySelector(QualitySelector.from(Quality.HIGHEST))
                        .build()
                    videoCapture = VideoCapture.withOutput(recorder)

                    cameraProvider?.unbindAll()

                    camera = cameraProvider?.bindToLifecycle(
                        activity as LifecycleOwner,
                        currentCameraSelector,
                        preview,
                        imageCapture,
                        videoCapture
                    )

                    // Apply stored torch setting.
                    applyTorch(currentSettings["flash"] as? String == "torch")

                    // Start frame event emission.
                    startFrameEvents()

                    call.resolve(JSObject().apply {
                        put("width", width)
                        put("height", height)
                        put("deviceId", if (direction == "front") "front" else "back")
                    })
                } catch (e: Exception) {
                    notifyListeners("error", JSObject().apply {
                        put("code", "PREVIEW_ERROR")
                        put("message", "Failed to start preview: ${e.message}")
                    })
                    call.reject("Failed to start preview: ${e.message}")
                }
            }, ContextCompat.getMainExecutor(context))
        }
    }

    @PluginMethod
    fun stopPreview(call: PluginCall) {
        activity.runOnUiThread {
            stopPreviewInternal()
            call.resolve()
        }
    }

    private fun stopPreviewInternal() {
        stopFrameEvents()

        if (isRecording) {
            currentRecording?.stop()
            isRecording = false
        }

        recordingTimer?.removeCallbacks(recordingRunnable ?: Runnable {})
        recordingTimer = null
        recordingRunnable = null

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
        if (cameraProvider == null) {
            call.reject("Preview not started")
            return
        }

        val direction = call.getString("direction")
            ?: if (currentCameraSelector == CameraSelector.DEFAULT_BACK_CAMERA) "front" else "back"
        val mirror = direction == "front"

        activity.runOnUiThread {
            currentDirection = direction
            currentCameraSelector = if (direction == "front") {
                CameraSelector.DEFAULT_FRONT_CAMERA
            } else {
                CameraSelector.DEFAULT_BACK_CAMERA
            }

            previewView?.scaleX = if (mirror) -1f else 1f

            cameraProvider?.unbindAll()

            try {
                camera = cameraProvider?.bindToLifecycle(
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
        val tempFile = File.createTempFile("milaidy-snap-", ".jpg", context.cacheDir)
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
        if (isRecording) {
            call.reject("Already recording")
            return
        }

        val videoCapture = this.videoCapture ?: run {
            call.reject("Camera not ready")
            return
        }

        val saveToGallery = call.getBoolean("saveToGallery") ?: false
        val includeAudio = call.getBoolean("audio") ?: true
        val maxDuration = call.getDouble("maxDuration")

        if (includeAudio && getPermissionState("microphone") != com.getcapacitor.PermissionState.GRANTED) {
            pendingCall = call
            requestPermissionForAlias("microphone", call, "handleMicPermissionForRecording")
            return
        }

        startRecordingInternal(call, saveToGallery, includeAudio, maxDuration)
    }

    @PermissionCallback
    private fun handleMicPermissionForRecording(call: PluginCall) {
        val saveToGallery = call.getBoolean("saveToGallery") ?: false
        val includeAudio =
            getPermissionState("microphone") == com.getcapacitor.PermissionState.GRANTED
        val maxDuration = call.getDouble("maxDuration")
        startRecordingInternal(call, saveToGallery, includeAudio, maxDuration)
    }

    @android.annotation.SuppressLint("MissingPermission")
    private fun startRecordingInternal(
        call: PluginCall,
        saveToGallery: Boolean,
        includeAudio: Boolean,
        maxDuration: Double?
    ) {
        val videoCapture = this.videoCapture ?: return

        val fileName =
            "VID_${SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())}.mp4"

        currentRecordingSaveToGallery = saveToGallery

        val outputOptions = if (saveToGallery && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val contentValues = ContentValues().apply {
                put(MediaStore.Video.Media.DISPLAY_NAME, fileName)
                put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
                put(
                    MediaStore.Video.Media.RELATIVE_PATH,
                    Environment.DIRECTORY_MOVIES
                )
            }
            currentRecordingFile = null
            MediaStoreOutputOptions.Builder(
                context.contentResolver,
                MediaStore.Video.Media.EXTERNAL_CONTENT_URI
            ).setContentValues(contentValues).build()
        } else {
            val file = File(context.cacheDir, fileName)
            currentRecordingFile = file
            FileOutputOptions.Builder(file).build()
        }

        val pendingRecording = videoCapture.output
            .prepareRecording(context, outputOptions)

        if (includeAudio) {
            pendingRecording.withAudioEnabled()
        }

        isRecording = true
        recordingStartTime = System.currentTimeMillis()

        currentRecording =
            pendingRecording.start(ContextCompat.getMainExecutor(context)) { recordEvent ->
                when (recordEvent) {
                    is VideoRecordEvent.Start -> {
                        notifyListeners("recordingState", JSObject().apply {
                            put("isRecording", true)
                            put("duration", 0)
                            put("fileSize", 0)
                        })
                    }
                    is VideoRecordEvent.Status -> {
                        // CameraX emits periodic status events with stats.
                        val stats = recordEvent.recordingStats
                        notifyListeners("recordingState", JSObject().apply {
                            put("isRecording", true)
                            put(
                                "duration",
                                (System.currentTimeMillis() - recordingStartTime) / 1000.0
                            )
                            put("fileSize", stats.numBytesRecorded)
                        })
                    }
                    is VideoRecordEvent.Finalize -> {
                        isRecording = false
                        if (recordEvent.hasError()) {
                            notifyListeners("error", JSObject().apply {
                                put("code", "RECORDING_ERROR")
                                put(
                                    "message",
                                    "Recording failed: ${recordEvent.cause?.message}"
                                )
                            })
                        }
                        notifyListeners("recordingState", JSObject().apply {
                            put("isRecording", false)
                            put(
                                "duration",
                                (System.currentTimeMillis() - recordingStartTime) / 1000.0
                            )
                            put("fileSize", recordEvent.recordingStats.numBytesRecorded)
                        })
                    }
                }
            }

        // Periodic duration timer as fallback for events.
        recordingTimer = Handler(Looper.getMainLooper())
        recordingRunnable = object : Runnable {
            override fun run() {
                if (isRecording) {
                    val duration =
                        (System.currentTimeMillis() - recordingStartTime) / 1000.0

                    if (maxDuration != null && duration >= maxDuration) {
                        scope.launch { stopRecordingInternal() }
                    } else {
                        recordingTimer?.postDelayed(this, 500)
                    }
                }
            }
        }
        recordingTimer?.postDelayed(recordingRunnable!!, 500)

        call.resolve()
    }

    @PluginMethod
    fun stopRecording(call: PluginCall) {
        if (!isRecording) {
            call.reject("Not recording")
            return
        }

        scope.launch {
            val result = stopRecordingInternal()
            if (result != null) {
                call.resolve(result)
            } else {
                call.reject("Failed to stop recording")
            }
        }
    }

    private suspend fun stopRecordingInternal(): JSObject? = withContext(Dispatchers.Main) {
        recordingTimer?.removeCallbacks(recordingRunnable ?: return@withContext null)
        recordingTimer = null
        recordingRunnable = null

        val duration = (System.currentTimeMillis() - recordingStartTime) / 1000.0

        return@withContext suspendCancellableCoroutine { continuation ->
            currentRecording?.stop()
            currentRecording = null
            isRecording = false

            val filePath = currentRecordingFile?.absolutePath ?: ""
            val fileSize = currentRecordingFile?.length() ?: 0L

            continuation.resume(JSObject().apply {
                put("path", filePath)
                put("duration", duration)
                put("width", currentPreviewWidth)
                put("height", currentPreviewHeight)
                put("fileSize", fileSize)
                put("mimeType", "video/mp4")
            }, null)
        }
    }

    @PluginMethod
    fun getRecordingState(call: PluginCall) {
        val duration =
            if (isRecording) (System.currentTimeMillis() - recordingStartTime) / 1000.0 else 0.0

        call.resolve(JSObject().apply {
            put("isRecording", isRecording)
            put("duration", duration)
            put("fileSize", currentRecordingFile?.length() ?: 0)
        })
    }

    // ---- Settings ----

    @PluginMethod
    fun getSettings(call: PluginCall) {
        call.resolve(JSObject().apply {
            put("settings", JSObject().apply {
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
            })
        })
    }

    @PluginMethod
    fun setSettings(call: PluginCall) {
        val settings = call.getObject("settings") ?: run {
            call.reject("Missing settings")
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

    // ---- Zoom ----

    @PluginMethod
    fun setZoom(call: PluginCall) {
        val zoom = call.getFloat("zoom") ?: run {
            call.reject("Missing zoom parameter")
            return
        }
        applyZoom(zoom)
        currentSettings["zoom"] = zoom
        call.resolve()
    }

    private fun applyZoom(zoom: Float) {
        // CameraX setLinearZoom expects 0..1 range. Map 1..maxZoom to 0..1.
        val zoomState = camera?.cameraInfo?.zoomState?.value
        val maxZoom = zoomState?.maxZoomRatio ?: 10f
        val minZoom = zoomState?.minZoomRatio ?: 1f
        val linearZoom = ((zoom - minZoom) / (maxZoom - minZoom)).coerceIn(0f, 1f)
        camera?.cameraControl?.setLinearZoom(linearZoom)
    }

    // ---- Focus ----

    @PluginMethod
    fun setFocusPoint(call: PluginCall) {
        val x = call.getFloat("x") ?: run {
            call.reject("Missing x coordinate")
            return
        }
        val y = call.getFloat("y") ?: run {
            call.reject("Missing y coordinate")
            return
        }

        previewView?.let { view ->
            val factory = view.meteringPointFactory
            val point = factory.createPoint(x * view.width, y * view.height)
            val action = FocusMeteringAction.Builder(point, FocusMeteringAction.FLAG_AF)
                .setAutoCancelDuration(3, java.util.concurrent.TimeUnit.SECONDS)
                .build()
            camera?.cameraControl?.startFocusAndMetering(action)
        }

        currentSettings["focusMode"] = "manual"
        call.resolve()
    }

    // ---- Exposure ----

    @PluginMethod
    fun setExposurePoint(call: PluginCall) {
        val x = call.getFloat("x") ?: run {
            call.reject("Missing x coordinate")
            return
        }
        val y = call.getFloat("y") ?: run {
            call.reject("Missing y coordinate")
            return
        }

        previewView?.let { view ->
            val factory = view.meteringPointFactory
            val point = factory.createPoint(x * view.width, y * view.height)
            val action = FocusMeteringAction.Builder(point, FocusMeteringAction.FLAG_AE)
                .setAutoCancelDuration(3, java.util.concurrent.TimeUnit.SECONDS)
                .build()
            camera?.cameraControl?.startFocusAndMetering(action)
        }

        currentSettings["exposureMode"] = "manual"
        call.resolve()
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

    // ---- Frame Events ----

    private fun startFrameEvents() {
        stopFrameEvents()
        frameCount = 0
        frameTimer = Handler(Looper.getMainLooper())
        frameRunnable = object : Runnable {
            override fun run() {
                if (camera != null) {
                    frameCount++
                    notifyListeners("frame", JSObject().apply {
                        put("timestamp", System.currentTimeMillis())
                        put("width", currentPreviewWidth)
                        put("height", currentPreviewHeight)
                    })
                    // Emit at ~2 Hz to avoid flooding the bridge.
                    frameTimer?.postDelayed(this, 500)
                }
            }
        }
        frameTimer?.postDelayed(frameRunnable!!, 500)
    }

    private fun stopFrameEvents() {
        frameRunnable?.let { frameTimer?.removeCallbacks(it) }
        frameTimer = null
        frameRunnable = null
    }

    // ---- Permissions ----

    @PluginMethod
    fun checkPermissions(call: PluginCall) {
        val cameraStatus = getPermissionState("camera")
        val micStatus = getPermissionState("microphone")

        call.resolve(JSObject().apply {
            put("camera", permissionString(cameraStatus))
            put("microphone", permissionString(micStatus))
            put("photos", "granted")
        })
    }

    @PluginMethod
    fun requestPermissions(call: PluginCall) {
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
        super.handleOnDestroy()
        stopPreviewInternal()
        scope.cancel()
    }
}
