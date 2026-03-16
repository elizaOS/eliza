package ai.milaidy.plugins.screencapture

import android.Manifest
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
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

    // Recording state
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
    private var pendingAction: String? = null
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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            features.put("system_audio")
        }
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
        pendingCall = call
        pendingAction = "screenshot"

        val intent = mediaProjectionManager?.createScreenCaptureIntent()
        if (intent != null) {
            startActivityForResult(call, intent, "handleProjectionResult")
        } else {
            call.reject("Screen capture not available")
        }
    }

    @PluginMethod
    fun startRecording(call: PluginCall) {
        if (isRecording) {
            call.reject("Recording already in progress")
            return
        }

        // Parse recording options
        val config = parseRecordingConfig(call)
        pendingRecordingOptions = config

        // Check mic permission if microphone capture requested
        if (config.captureMicrophone &&
            getPermissionState("microphone") != com.getcapacitor.PermissionState.GRANTED
        ) {
            pendingCall = call
            pendingAction = "recording"
            requestPermissionForAlias("microphone", call, "handleMicPermissionResult")
            return
        }

        pendingCall = call
        pendingAction = "recording"

        val intent = mediaProjectionManager?.createScreenCaptureIntent()
        if (intent != null) {
            startActivityForResult(call, intent, "handleProjectionResult")
        } else {
            call.reject("Screen capture not available")
        }
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
    fun checkPermissions(call: PluginCall) {
        val micStatus = getPermissionState("microphone")
        call.resolve(JSObject().apply {
            put("screenCapture", "prompt") // Always prompt for MediaProjection
            put("microphone", permissionString(micStatus))
        })
    }

    @PluginMethod
    fun requestPermissions(call: PluginCall) {
        requestPermissionForAlias("microphone", call, "handlePermissionsResult")
    }

    // ── Permission callbacks ────────────────────────────────────────────

    @PermissionCallback
    private fun handleMicPermissionResult(call: PluginCall) {
        val intent = mediaProjectionManager?.createScreenCaptureIntent()
        if (intent != null) {
            startActivityForResult(call, intent, "handleProjectionResult")
        } else {
            call.reject("Screen capture not available")
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
        if (result.resultCode != Activity.RESULT_OK || result.data == null) {
            call.reject("Screen capture permission denied")
            return
        }

        mediaProjection = mediaProjectionManager?.getMediaProjection(result.resultCode, result.data!!)

        if (mediaProjection == null) {
            call.reject("Failed to get media projection")
            return
        }

        // Register stop callback for cleanup
        mediaProjection?.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() {
                Log.d(TAG, "MediaProjection stopped by system")
                if (isRecording) {
                    scope.launch { stopRecordingInternal() }
                }
            }
        }, Handler(Looper.getMainLooper()))

        when (pendingAction) {
            "screenshot" -> captureScreenshotInternal(call)
            "recording" -> startRecordingInternal(call)
            else -> call.reject("Unknown action")
        }
    }

    // ── Screenshot capture ──────────────────────────────────────────────

    private fun captureScreenshotInternal(call: PluginCall) {
        val format = call.getString("format") ?: "png"
        val quality = call.getInt("quality") ?: 100
        val scale = call.getFloat("scale") ?: 1f

        val width = (screenWidth * scale).toInt()
        val height = (screenHeight * scale).toInt()

        imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)

        virtualDisplay = mediaProjection?.createVirtualDisplay(
            "ScreenCapture",
            width,
            height,
            screenDensity,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            imageReader?.surface,
            null,
            null
        )

        // Brief delay to allow the VirtualDisplay to render a frame
        Handler(Looper.getMainLooper()).postDelayed({
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

                    cleanup()

                    call.resolve(JSObject().apply {
                        put("base64", base64)
                        put("format", format)
                        put("width", width)
                        put("height", height)
                        put("timestamp", System.currentTimeMillis())
                    })
                } else {
                    cleanup()
                    call.reject("Failed to capture screenshot")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Screenshot capture failed", e)
                cleanup()
                notifyError("screenshot_failed", "Screenshot failed: ${e.message}")
                call.reject("Screenshot failed: ${e.message}")
            }
        }, 250) // 250ms delay to ensure frame is rendered
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
        val config = pendingRecordingOptions ?: RecordingConfig()
        pendingRecordingOptions = null

        val fps = config.fps
        val bitrate = config.bitrate ?: estimateBitrate(screenWidth, screenHeight, fps)

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
                        what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_MS_REACHED
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

            call.resolve()

        } catch (e: Exception) {
            Log.e(TAG, "Failed to start recording", e)
            mediaRecorder?.release()
            mediaRecorder = null
            cleanup()
            notifyError("recording_start_failed", "Failed to start recording: ${e.message}")
            call.reject("Failed to start recording: ${e.message}")
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
        recordingTimer?.removeCallbacks(recordingRunnable ?: return@withContext null)
        recordingTimer = null
        recordingRunnable = null

        val duration = getRecordingDuration()

        try {
            mediaRecorder?.stop()
        } catch (e: Exception) {
            Log.w(TAG, "MediaRecorder.stop() failed (may be empty recording)", e)
        }

        mediaRecorder?.release()
        mediaRecorder = null
        isRecording = false
        isPaused = false
        pausedDurationMs = 0
        pauseStartTime = 0
        maxDurationMs = null
        maxFileSize = null

        cleanup()

        val file = outputFile ?: return@withContext null
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
        }
    }

    // ── Recording config parsing ────────────────────────────────────────

    private data class RecordingConfig(
        val quality: String? = null,
        val maxDuration: Double? = null,
        val maxFileSize: Long? = null,
        val fps: Int = 30,
        val bitrate: Int? = null,
        val captureMicrophone: Boolean = false,
        val captureSystemAudio: Boolean = false
    )

    private fun parseRecordingConfig(call: PluginCall): RecordingConfig {
        val quality = call.getString("quality")
        val maxDuration = call.getDouble("maxDuration")
        val maxFileSize = call.getLong("maxFileSize")
        val captureMicrophone = call.getBoolean("captureMicrophone") ?: false
        val captureSystemAudio = call.getBoolean("captureSystemAudio") ?: false

        // Apply quality presets or use explicit values
        val presetFps: Int
        val presetBitrate: Int?
        when (quality?.lowercase()) {
            "low" -> {
                presetFps = 15
                presetBitrate = estimateBitrate(screenWidth, screenHeight, 15) / 2
            }
            "medium" -> {
                presetFps = 24
                presetBitrate = null // use estimate
            }
            "high" -> {
                presetFps = 30
                presetBitrate = null // use estimate
            }
            "highest" -> {
                presetFps = 60
                presetBitrate = estimateBitrate(screenWidth, screenHeight, 60) * 2
            }
            else -> {
                presetFps = 30
                presetBitrate = null
            }
        }

        val fps = call.getInt("fps") ?: presetFps
        val bitrate = call.getInt("bitrate") ?: presetBitrate

        return RecordingConfig(
            quality = quality,
            maxDuration = maxDuration,
            maxFileSize = maxFileSize,
            fps = fps.coerceIn(1, 60),
            bitrate = bitrate,
            captureMicrophone = captureMicrophone,
            captureSystemAudio = captureSystemAudio
        )
    }

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

    /**
     * Estimate a reasonable video bitrate based on resolution and frame rate.
     * Ported from classic ScreenRecordManager.
     */
    private fun estimateBitrate(width: Int, height: Int, fps: Int): Int {
        val pixels = width.toLong() * height.toLong()
        val raw = (pixels * fps.toLong() * 2L).toInt()
        return raw.coerceIn(1_000_000, 12_000_000)
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
        mediaProjection?.stop()
        mediaProjection = null
    }

    // ── Destroy ─────────────────────────────────────────────────────────

    override fun handleOnDestroy() {
        super.handleOnDestroy()
        if (isRecording) {
            try {
                mediaRecorder?.stop()
            } catch (_: Exception) {}
            mediaRecorder?.release()
            mediaRecorder = null
            isRecording = false
        }
        cleanup()
        scope.cancel()
    }
}
