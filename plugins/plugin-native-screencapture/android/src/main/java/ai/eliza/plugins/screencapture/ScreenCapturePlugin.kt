/**
 * Owns Android screenshot and recording resources for the Capacitor screen-capture bridge.
 * Recording results are returned only after native finalization succeeds and the output exists.
 */
package ai.eliza.plugins.screencapture

import android.Manifest
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.MediaRecorder
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import kotlinx.coroutines.*
import java.io.ByteArrayOutputStream
import java.io.File
import java.text.SimpleDateFormat
import java.util.*

@CapacitorPlugin(
    name = "ScreenCapture",
    permissions = [
        Permission(alias = "microphone", strings = [Manifest.permission.RECORD_AUDIO])
    ]
)
class ScreenCapturePlugin : Plugin() {
    companion object {
        private const val TAG = "ScreenCapture"
        private const val NOTIFICATION_CHANNEL_ID = "screen_capture_channel"
        private const val NOTIFICATION_ID = 9001
    }

    private var mediaProjectionManager: MediaProjectionManager? = null
    private var mediaProjection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var mediaRecorder: MediaRecorder? = null
    private var imageReader: ImageReader? = null
    // Dimensions of the warm screenshot VirtualDisplay, so repeated captures at
    // the same scale reuse it instead of re-creating it each frame.
    private var screenshotVdWidth = 0
    private var screenshotVdHeight = 0

    // Recording state
    private var completedRecording: JSObject? = null
    private var recordingFinalizationFailed = false
    private var isRecording = false
    private var isPaused = false
    private var recordingStartTime = 0L
    private var pausedDurationMs = 0L
    private var pauseStartTime = 0L
    private var outputFile: File? = null
    private var recordingTimer: Handler? = null
    private var recordingRunnable: Runnable? = null
    private var maxDurationMs: Long? = null
    private var maxFileSize: Long? = null

    // Pending permission flow
    private var pendingCall: PluginCall? = null
    private enum class CaptureAction { SCREENSHOT, RECORDING }
    private var pendingAction: CaptureAction? = null
    private val admissionHandler = Handler(Looper.getMainLooper())
    private var destroyed = false

    private fun admit(call: PluginCall, action: CaptureAction): Boolean {
        if (destroyed) {
            call.reject("Screen capture has been destroyed", "CAPTURE_DESTROYED")
            return false
        }
        if (pendingCall != null || isRecording) {
            call.reject("Another screen capture request is active", "CAPTURE_BUSY")
            return false
        }
        pendingCall = call
        pendingAction = action
        return true
    }

    private fun finishAdmission(call: PluginCall) {
        if (pendingCall === call) {
            pendingCall = null
            pendingAction = null
            pendingRecordingOptions = null
        }
    }

    private fun rejectAdmission(call: PluginCall, message: String, code: String) {
        finishAdmission(call)
        call.reject(message, code)
    }
    private var pendingRecordingOptions: RecordingConfig? = null

    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private var screenDensity = 0
    private var screenWidth = 0
    private var screenHeight = 0

    // ── Lifecycle ────────────────────────────────────────────────────────

    override fun load() {
        super.load()
        mediaProjectionManager =
            context.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager

        updateScreenMetrics()
        createNotificationChannel()
    }

    private fun updateScreenMetrics() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
            val metrics = windowManager.currentWindowMetrics
            val bounds = metrics.bounds
            screenWidth = bounds.width()
            screenHeight = bounds.height()
            val config = context.resources.configuration
            screenDensity = config.densityDpi
        } else {
            val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
            val metrics = DisplayMetrics()
            @Suppress("DEPRECATION")
            windowManager.defaultDisplay.getMetrics(metrics)
            screenDensity = metrics.densityDpi
            screenWidth = metrics.widthPixels
            screenHeight = metrics.heightPixels
        }
    }

    /**
     * Notification channel required for the foreground service on Android 14+.
     */
    private fun createNotificationChannel() {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(NOTIFICATION_CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            NOTIFICATION_CHANNEL_ID,
            "Screen Capture",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Used while capturing or recording the screen"
        }
        nm.createNotificationChannel(channel)
    }

    // ── Plugin methods ──────────────────────────────────────────────────

    @PluginMethod
    fun isSupported(call: PluginCall) {
        val features = JSArray()
        features.put("screenshot")
        features.put("recording")
        features.put("microphone")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            features.put("pause_resume")
        }

        call.resolve(JSObject().apply {
            put("supported", true)
            put("features", features)
        })
    }

    @PluginMethod
    fun captureScreenshot(call: PluginCall) {
        admissionHandler.post {
            if (admit(call, CaptureAction.SCREENSHOT)) beginScreenshot(call)
        }
    }

    private fun beginScreenshot(call: PluginCall) {

        // Reuse an already-granted session projection instead of re-prompting
        // the system consent dialog on every capture. Continuous screen
        // understanding (EPIC #9105) captures repeatedly; tearing the projection
        // down + re-consenting per frame is a battery/latency/UX killer. The
        // projection is kept warm across captures and only released on
        // background/destroy or when the system stops it.
        if (mediaProjection != null) {
            executeScreenshot(call)
            return
        }

        val intent = mediaProjectionManager?.createScreenCaptureIntent()
        if (intent != null) {
            startActivityForResult(call, intent, "handleProjectionResult")
        } else {
            rejectAdmission(call, "Screen capture not available", "CAPTURE_UNAVAILABLE")
        }
    }

    @PluginMethod
    fun startRecording(call: PluginCall) {
        admissionHandler.post {
            if (admit(call, CaptureAction.RECORDING)) beginRecording(call)
        }
    }

    private fun beginRecording(call: PluginCall) {
        if (call.getBoolean("captureSystemAudio") == true) {
            rejectAdmission(call, "Android screen recording supports microphone audio only", "SYSTEM_AUDIO_UNSUPPORTED")
            return
        }
        val sizeValue = call.data.opt("maxFileSize")
        val sizeNumber = (sizeValue as? Number)?.toDouble()
        if (call.data.has("maxFileSize") && (sizeNumber == null || !sizeNumber.isFinite() ||
                sizeNumber <= 0 || sizeNumber > 9_007_199_254_740_991.0 || sizeNumber % 1.0 != 0.0)) {
            rejectAdmission(call, "maxFileSize must be a positive safe integer number of bytes", "INVALID_RECORDING_OPTIONS")
            return
        }
        releaseProjection()

        // Parse recording options
        val config = parseRecordingConfig(call, sizeNumber?.toLong())
        pendingRecordingOptions = config

        // Check mic permission if microphone capture requested
        if (config.captureMicrophone &&
            getPermissionState("microphone") != com.getcapacitor.PermissionState.GRANTED
        ) {
            requestPermissionForAlias("microphone", call, "handleMicPermissionResult")
            return
        }


        val intent = mediaProjectionManager?.createScreenCaptureIntent()
        if (intent != null) {
            startActivityForResult(call, intent, "handleProjectionResult")
        } else {
            rejectAdmission(call, "Screen capture not available", "CAPTURE_UNAVAILABLE")
        }
    }

    @PluginMethod
    fun stopRecording(call: PluginCall) {
        scope.launch {
            val result = if (isRecording) stopRecordingInternal() else completedRecording
            when {
                result != null -> call.resolve(result)
                recordingFinalizationFailed -> call.reject("Recording could not be finalized", "RECORDING_FINALIZATION_FAILED")
                else -> call.reject("Not recording")
            }
        }
    }

    @PluginMethod
    fun pauseRecording(call: PluginCall) {
        if (!isRecording) {
            call.reject("Not recording")
            return
        }
        if (isPaused) {
            call.reject("Already paused")
            return
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            try {
                mediaRecorder?.pause()
                isPaused = true
                pauseStartTime = System.currentTimeMillis()

                notifyListeners("recordingState", JSObject().apply {
                    put("isRecording", true)
                    put("isPaused", true)
                    put("duration", getRecordingDuration())
                    put("fileSize", outputFile?.length() ?: 0)
                })
                call.resolve()
            } catch (e: Exception) {
                Log.e(TAG, "Failed to pause recording", e)
                notifyError("pause_failed", "Failed to pause: ${e.message}")
                call.reject("Failed to pause recording: ${e.message}")
            }
        } else {
            call.reject("Pause is not supported on this Android version (requires API 24+)")
        }
    }

    @PluginMethod
    fun resumeRecording(call: PluginCall) {
        if (!isRecording) {
            call.reject("Not recording")
            return
        }
        if (!isPaused) {
            call.reject("Not paused")
            return
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            try {
                mediaRecorder?.resume()
                // Track paused duration for accurate timing
                if (pauseStartTime > 0) {
                    pausedDurationMs += System.currentTimeMillis() - pauseStartTime
                    pauseStartTime = 0
                }
                isPaused = false

                notifyListeners("recordingState", JSObject().apply {
                    put("isRecording", true)
                    put("isPaused", false)
                    put("duration", getRecordingDuration())
                    put("fileSize", outputFile?.length() ?: 0)
                })
                call.resolve()
            } catch (e: Exception) {
                Log.e(TAG, "Failed to resume recording", e)
                notifyError("resume_failed", "Failed to resume: ${e.message}")
                call.reject("Failed to resume recording: ${e.message}")
            }
        } else {
            call.reject("Resume is not supported on this Android version (requires API 24+)")
        }
    }

    @PluginMethod
    fun getRecordingState(call: PluginCall) {
        val duration = getRecordingDuration()
        val fileSize = outputFile?.length() ?: 0

        call.resolve(JSObject().apply {
            put("isRecording", isRecording)
            put("isPaused", isPaused)
            put("duration", duration)
            put("fileSize", fileSize)
        })
    }

    @PluginMethod
    override fun checkPermissions(call: PluginCall) {
        val micStatus = getPermissionState("microphone")
        call.resolve(JSObject().apply {
            put("screenCapture", "prompt") // Always prompt for MediaProjection
            put("microphone", permissionString(micStatus))
        })
    }

    @PluginMethod
    override fun requestPermissions(call: PluginCall) {
        requestPermissionForAlias("microphone", call, "handlePermissionsResult")
    }

    // ── Permission callbacks ────────────────────────────────────────────

    @PermissionCallback
    private fun handleMicPermissionResult(call: PluginCall) {
        if (pendingCall !== call || destroyed) return
        if (getPermissionState("microphone") != com.getcapacitor.PermissionState.GRANTED) {
            rejectAdmission(call, "Microphone permission denied", "MICROPHONE_DENIED")
            return
        }
        val intent = mediaProjectionManager?.createScreenCaptureIntent()
        if (intent != null) {
            startActivityForResult(call, intent, "handleProjectionResult")
        } else {
            rejectAdmission(call, "Screen capture not available", "CAPTURE_UNAVAILABLE")
        }
    }

    @PermissionCallback
    private fun handlePermissionsResult(call: PluginCall) {
        val micStatus = getPermissionState("microphone")
        call.resolve(JSObject().apply {
            put("screenCapture", "prompt")
            put("microphone", permissionString(micStatus))
        })
    }

    // ── Activity result (MediaProjection permission) ────────────────────

    @ActivityCallback
    private fun handleProjectionResult(call: PluginCall, result: ActivityResult) {
        if (pendingCall !== call || destroyed) return
        if (result.resultCode != Activity.RESULT_OK || result.data == null) {
            rejectAdmission(call, "Screen capture permission denied", "CAPTURE_DENIED")
            return
        }

        // Android 14+ (API 34) throws SecurityException from getMediaProjection()
        // unless a foreground service of type mediaProjection is ALREADY running.
        // Start it now, then acquire the projection once it has gone foreground.
        try {
            ContextCompat.startForegroundService(
                context,
                Intent(context, ScreenCaptureFgService::class.java)
            )
        } catch (e: Exception) {
            // error-policy:J1 foreground-service admission failure rejects the owning capture request.
            Log.w(TAG, "Could not start mediaProjection FGS", e)
            rejectAdmission(call, "Screen capture service could not start", "CAPTURE_UNAVAILABLE")
            return
        }

        admissionHandler.postDelayed({
            if (pendingCall !== call || destroyed) return@postDelayed
            try {
                mediaProjection =
                    mediaProjectionManager?.getMediaProjection(result.resultCode, result.data!!)
            } catch (e: Exception) {
                Log.e(TAG, "getMediaProjection failed", e)
                stopFgService()
                rejectAdmission(call, "Media projection failed", "CAPTURE_UNAVAILABLE")
                return@postDelayed
            }
            if (mediaProjection == null) {
                stopFgService()
                rejectAdmission(call, "Failed to get media projection", "CAPTURE_UNAVAILABLE")
                return@postDelayed
            }

            // Register stop callback for cleanup
            val ownedProjection = requireNotNull(mediaProjection)
            ownedProjection.registerCallback(object : MediaProjection.Callback() {
                override fun onStop() {
                    if (mediaProjection !== ownedProjection) return
                    Log.d(TAG, "MediaProjection stopped by system")
                    if (isRecording) {
                        scope.launch { stopRecordingInternal() }
                    }
                    // The session projection is gone — drop our warm references so
                    // the next captureScreenshot re-acquires consent cleanly instead
                    // of using a dead projection.
                    virtualDisplay?.release()
                    virtualDisplay = null
                    imageReader?.close()
                    imageReader = null
                    screenshotVdWidth = 0
                    screenshotVdHeight = 0
                    mediaProjection = null
                    stopFgService()
                }
            }, Handler(Looper.getMainLooper()))

            when (pendingAction) {
                CaptureAction.SCREENSHOT -> executeScreenshot(call)
                CaptureAction.RECORDING -> startRecordingInternal(call)
                null -> rejectAdmission(call, "Capture request lost its owner", "CAPTURE_UNAVAILABLE")
            }
        }, 600)
    }

    /** Stop the mediaProjection foreground service (idempotent). */
    private fun stopFgService() {
        try {
            context.stopService(Intent(context, ScreenCaptureFgService::class.java))
        } catch (e: Exception) {
            Log.w(TAG, "stopFgService failed", e)
        }
    }

    // ── Screenshot capture ──────────────────────────────────────────────

    private fun executeScreenshot(call: PluginCall) {
        try {
            captureScreenshotInternal(call)
        } catch (error: Exception) {
            // error-policy:J1 screenshot setup failure releases admission and reports a bridge failure.
            Log.w(TAG, "ScreenCapture: screenshot setup failed", error)
            releaseProjection()
            rejectAdmission(call, "Screenshot setup failed", "CAPTURE_UNAVAILABLE")
        }
    }

    private fun captureScreenshotInternal(call: PluginCall) {
        val format = call.getString("format") ?: "png"
        val quality = call.getInt("quality") ?: 100
        val scale = call.getFloat("scale") ?: 1f

        val width = Math.max(1, (screenWidth * scale).toInt())
        val height = Math.max(1, (screenHeight * scale).toInt())

        // Android 14+ permits one virtual display per projection token. Resizing
        // replaces its surface while preserving that display and consent session.
        val warm = virtualDisplay != null &&
            imageReader != null &&
            screenshotVdWidth == width &&
            screenshotVdHeight == height
        if (!warm) {
            val oldReader = imageReader
            val replacement = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
            imageReader = replacement
            try {
                val display = virtualDisplay
                if (display == null) {
                    virtualDisplay = requireNotNull(mediaProjection).createVirtualDisplay(
                        "ScreenCapture",
                        width,
                        height,
                        screenDensity,
                        DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                        replacement.surface,
                        null,
                        null
                    )
                } else {
                    display.surface = null
                    display.resize(width, height, screenDensity)
                    display.surface = replacement.surface
                }
            } finally {
                oldReader?.close()
            }
            screenshotVdWidth = width
            screenshotVdHeight = height
        }

        // A freshly-created mirror needs ~250ms to render its first frame; a warm
        // display is already mirroring continuously, so a short settle suffices.
        val settleMs = if (warm) 60L else 250L
        admissionHandler.postDelayed({
            if (pendingCall !== call || destroyed) return@postDelayed
            try {
                val image = imageReader?.acquireLatestImage()

                if (image != null) {
                    val bitmap = imageToBitmap(image, width, height)
                    image.close()

                    val outputStream = ByteArrayOutputStream()
                    val compressFormat = when (format) {
                        "jpeg" -> Bitmap.CompressFormat.JPEG
                        "webp" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                            Bitmap.CompressFormat.WEBP_LOSSY
                        } else {
                            @Suppress("DEPRECATION")
                            Bitmap.CompressFormat.WEBP
                        }
                        else -> Bitmap.CompressFormat.PNG
                    }

                    bitmap.compress(compressFormat, quality, outputStream)
                    bitmap.recycle()

                    val base64 = Base64.encodeToString(outputStream.toByteArray(), Base64.NO_WRAP)

                    // Keep the projection + VirtualDisplay warm for the next
                    // capture — do NOT cleanup() here (that stopped the
                    // projection and forced a re-consent every frame).

                    call.resolve(JSObject().apply {
                        put("base64", base64)
                        put("format", format)
                        put("width", width)
                        put("height", height)
                        put("timestamp", System.currentTimeMillis())
                    })
                } else {
                    // Transient empty frame — keep the session warm, just fail
                    // this one capture so the caller can retry on the next tick.
                    call.reject("Failed to capture screenshot")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Screenshot capture failed", e)
                // A real error may have invalidated the projection — tear it all
                // down so the next capture re-acquires cleanly.
                releaseProjection()
                notifyError("screenshot_failed", "Screenshot failed: ${e.message}")
                call.reject("Screenshot failed: ${e.message}")
            }
            finally { finishAdmission(call) }
        }, settleMs)
    }

    /**
     * Full teardown of the warm screenshot projection + its mirror. Use on
     * background/destroy or after an error invalidates the session. Recording
     * has its own lifecycle via [cleanup].
     */
    private fun releaseProjection() {
        virtualDisplay?.release()
        virtualDisplay = null
        imageReader?.close()
        imageReader = null
        screenshotVdWidth = 0
        screenshotVdHeight = 0
        val releasedProjection = mediaProjection
        mediaProjection = null
        releasedProjection?.stop()
        stopFgService()
    }

    private fun imageToBitmap(image: Image, width: Int, height: Int): Bitmap {
        val planes = image.planes
        val buffer = planes[0].buffer
        val pixelStride = planes[0].pixelStride
        val rowStride = planes[0].rowStride
        val rowPadding = rowStride - pixelStride * width

        val bitmap = Bitmap.createBitmap(
            width + rowPadding / pixelStride,
            height,
            Bitmap.Config.ARGB_8888
        )
        bitmap.copyPixelsFromBuffer(buffer)

        return if (rowPadding > 0) {
            val cropped = Bitmap.createBitmap(bitmap, 0, 0, width, height)
            if (cropped !== bitmap) bitmap.recycle()
            cropped
        } else {
            bitmap
        }
    }

    // ── Screen recording ────────────────────────────────────────────────

    private fun startRecordingInternal(call: PluginCall) {
        completedRecording = null
        recordingFinalizationFailed = false
        val config = pendingRecordingOptions ?: RecordingConfig()
        pendingRecordingOptions = null

        val fps = config.fps
        val bitrate = config.bitrate ?: RecordingConfigResolver.estimateBitrate(screenWidth, screenHeight, fps)

        val fileName = "screen_${SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())}.mp4"
        outputFile = File(context.cacheDir, fileName)

        try {
            mediaRecorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                MediaRecorder(context)
            } else {
                @Suppress("DEPRECATION")
                MediaRecorder()
            }

            mediaRecorder?.apply {
                // Audio source must be set before video source
                if (config.captureMicrophone) {
                    setAudioSource(MediaRecorder.AudioSource.MIC)
                }

                setVideoSource(MediaRecorder.VideoSource.SURFACE)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setVideoEncoder(MediaRecorder.VideoEncoder.H264)

                if (config.captureMicrophone) {
                    setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                    setAudioChannels(1)
                    setAudioSamplingRate(44100)
                    setAudioEncodingBitRate(96000)
                }

                setVideoSize(screenWidth, screenHeight)
                setVideoFrameRate(fps)
                setVideoEncodingBitRate(bitrate)
                setOutputFile(outputFile?.absolutePath)

                if (config.maxFileSize != null && config.maxFileSize > 0) {
                    setMaxFileSize(config.maxFileSize)
                }

                // Auto-stop callback when max file size or max duration is hit
                setOnInfoListener { _, what, _ ->
                    if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_REACHED ||
                        what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED
                    ) {
                        Log.d(TAG, "Recording auto-stopped (limit reached)")
                        scope.launch { stopRecordingInternal() }
                    }
                }

                setOnErrorListener { _, what, extra ->
                    Log.e(TAG, "MediaRecorder error: what=$what extra=$extra")
                    notifyError("recording_error", "MediaRecorder error: $what/$extra")
                    scope.launch { stopRecordingInternal() }
                }

                prepare()
            }

            virtualDisplay = mediaProjection?.createVirtualDisplay(
                "ScreenRecording",
                screenWidth,
                screenHeight,
                screenDensity,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                mediaRecorder?.surface,
                null,
                null
            )

            mediaRecorder?.start()
            isRecording = true
            isPaused = false
            recordingStartTime = System.currentTimeMillis()
            pausedDurationMs = 0
            pauseStartTime = 0

            // Store limits for timer-based auto-stop
            maxDurationMs = config.maxDuration?.let { (it * 1000).toLong() }
            maxFileSize = config.maxFileSize

            startRecordingTimer()

            notifyListeners("recordingState", JSObject().apply {
                put("isRecording", true)
                put("isPaused", false)
                put("duration", 0.0)
                put("fileSize", 0L)
            })

            finishAdmission(call)
            call.resolve()

        } catch (e: Exception) {
            Log.e(TAG, "Failed to start recording", e)
            mediaRecorder?.release()
            mediaRecorder = null
            cleanup()
            notifyError("recording_start_failed", "Failed to start recording: ${e.message}")
            rejectAdmission(call, "Failed to start recording: ${e.message}", "RECORDING_START_FAILED")
        }
    }

    private fun startRecordingTimer() {
        recordingTimer = Handler(Looper.getMainLooper())
        recordingRunnable = object : Runnable {
            override fun run() {
                if (!isRecording) return

                val duration = getRecordingDuration()
                val fileSize = outputFile?.length() ?: 0

                notifyListeners("recordingState", JSObject().apply {
                    put("isRecording", true)
                    put("isPaused", isPaused)
                    put("duration", duration)
                    put("fileSize", fileSize)
                })

                // Check maxDuration auto-stop
                val maxDur = maxDurationMs
                if (maxDur != null && !isPaused) {
                    val activeDuration = (duration * 1000).toLong()
                    if (activeDuration >= maxDur) {
                        Log.d(TAG, "Max duration reached, auto-stopping")
                        scope.launch { stopRecordingInternal() }
                        return
                    }
                }

                // Check maxFileSize auto-stop
                val maxSize = maxFileSize
                if (maxSize != null && fileSize >= maxSize) {
                    Log.d(TAG, "Max file size reached, auto-stopping")
                    scope.launch { stopRecordingInternal() }
                    return
                }

                recordingTimer?.postDelayed(this, 500)
            }
        }
        recordingTimer?.postDelayed(recordingRunnable!!, 500)
    }

    private suspend fun stopRecordingInternal(): JSObject? = withContext(Dispatchers.Main) {
        if (!isRecording) return@withContext completedRecording
        recordingRunnable?.let { recordingTimer?.removeCallbacks(it) }
        recordingTimer = null
        recordingRunnable = null

        val duration = getRecordingDuration()

        var finalizationFailed = false
        val recorder = mediaRecorder
        mediaRecorder = null
        try {
            requireNotNull(recorder) { "No recorder owns this recording" }.stop()
        } catch (e: Exception) {
            // error-policy:J1 return a failed recording result after releasing native resources.
            Log.w(TAG, "ScreenCapture: recording finalization failed", e)
            finalizationFailed = true
        }
        try {
            recorder?.release()
        } catch (e: Exception) {
            // error-policy:J6 release failure is logged and prevents reporting a successful recording.
            Log.w(TAG, "ScreenCapture: recorder release failed", e)
            finalizationFailed = true
        }
        isRecording = false
        isPaused = false
        pausedDurationMs = 0
        pauseStartTime = 0
        maxDurationMs = null
        maxFileSize = null

        cleanup()

        val file = outputFile
        if (finalizationFailed || file == null || !file.isFile || file.length() == 0L) {
            outputFile = null
            recordingFinalizationFailed = true
            completedRecording = null
            if (file != null && file.exists() && !file.delete()) {
                Log.w(TAG, "ScreenCapture: could not remove unfinished recording")
            }
            notifyListeners("recordingState", JSObject().apply {
                put("isRecording", false)
                put("isPaused", false)
                put("duration", duration)
                put("fileSize", 0L)
            })
            notifyError("recording_stop_failed", "Recording could not be finalized")
            return@withContext null
        }
        val fileSize = file.length()

        notifyListeners("recordingState", JSObject().apply {
            put("isRecording", false)
            put("isPaused", false)
            put("duration", duration)
            put("fileSize", fileSize)
        })

        JSObject().apply {
            put("path", file.absolutePath)
            put("duration", duration)
            put("width", screenWidth)
            put("height", screenHeight)
            put("fileSize", fileSize)
            put("mimeType", "video/mp4")
        }.also { completedRecording = it }
    }

    // ── Recording config parsing ────────────────────────────────────────

    private fun parseRecordingConfig(call: PluginCall, maxFileSize: Long?): RecordingConfig =
        RecordingConfigResolver.resolve(
            quality = call.getString("quality"),
            fpsOverride = call.getInt("fps"),
            bitrateOverride = call.getInt("bitrate"),
            maxDuration = call.getDouble("maxDuration"),
            maxFileSize = maxFileSize,
            captureMicrophone = call.getBoolean("captureMicrophone") ?: false,
            screenWidth = screenWidth,
            screenHeight = screenHeight,
        )

    // ── Helpers ──────────────────────────────────────────────────────────

    /**
     * Get recording duration in seconds, accounting for paused time.
     */
    private fun getRecordingDuration(): Double {
        if (!isRecording) return 0.0
        val now = System.currentTimeMillis()
        val totalElapsed = now - recordingStartTime
        val currentPauseDuration = if (isPaused && pauseStartTime > 0) {
            now - pauseStartTime
        } else 0L
        val activeDuration = totalElapsed - pausedDurationMs - currentPauseDuration
        return activeDuration.toDouble() / 1000.0
    }

    private fun permissionString(status: com.getcapacitor.PermissionState?): String {
        return when (status) {
            com.getcapacitor.PermissionState.GRANTED -> "granted"
            com.getcapacitor.PermissionState.DENIED -> "denied"
            else -> "prompt"
        }
    }

    private fun notifyError(code: String, message: String) {
        notifyListeners("error", JSObject().apply {
            put("code", code)
            put("message", message)
        })
    }

    private fun cleanup() {
        virtualDisplay?.release()
        virtualDisplay = null
        imageReader?.close()
        imageReader = null
        screenshotVdWidth = 0
        screenshotVdHeight = 0
        val releasedProjection = mediaProjection
        mediaProjection = null
        releasedProjection?.stop()
        stopFgService()
    }

    // ── Lifecycle ───────────────────────────────────────────────────────

    override fun handleOnStop() {
        super.handleOnStop()
        // Release the warm screenshot MediaProjection when the app is no longer
        // visible. A backgrounded app must not hold a live screen-capture
        // session — it drains battery, keeps the system cast/record indicator
        // up, and is a privacy concern. (handleOnStop fires on full background,
        // not the transient pause the consent dialog causes, so it won't tear
        // down a projection mid-acquisition.) Recording owns its own projection
        // lifecycle, so leave it alone while a recording is active.
        if (!isRecording) {
            releaseProjection()
        }
    }

    override fun handleOnDestroy() {
        destroyed = true
        // Queued admissions must run their destroyed guard and settle their callers.
        pendingCall?.let { rejectAdmission(it, "Screen capture was destroyed", "CAPTURE_DESTROYED") }
        pendingRecordingOptions = null
        recordingRunnable?.let { recordingTimer?.removeCallbacks(it) }
        recordingTimer = null
        recordingRunnable = null
        super.handleOnDestroy()
        if (isRecording) {
            try {
                mediaRecorder?.stop()
            } catch (error: Exception) {
                // error-policy:J6 destruction releases resources even when the recorder cannot finalize.
                Log.w(TAG, "ScreenCapture: recorder stop failed during destruction", error)
            }
            try {
                mediaRecorder?.release()
            } catch (error: Exception) {
                // error-policy:J6 recorder release failure must not prevent projection teardown.
                Log.w(TAG, "ScreenCapture: recorder release failed during destruction", error)
            }
            mediaRecorder = null
            isRecording = false
        }
        cleanup()
        scope.cancel()
    }
}
