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
import androidx.camera.core.resolutionselector.AspectRatioStrategy
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

    private companion object {
        const val FIRST_FRAME_TRACE = "alpha.camera.firstFrame"
        const val FIRST_FRAME_TIMEOUT_MS = 5000L
        // Safety net only: CameraX normally reports every unbound capture itself.
        const val CAPTURE_SETTLE_TIMEOUT_MS = 15000L
        const val THUMBNAIL_EDGE = 256
    }

    private var cameraProviderFuture: ListenableFuture<ProcessCameraProvider>? = null
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
    private val cameraPermissionRequests = CameraPermissionRequests<PluginCall>(object : CameraPermissionRequests.Host<PluginCall> {
        override fun request(alias: String, call: PluginCall) {
            requestPermissionForAlias(alias, call, "handleScopedCameraPermissionResult")
        }
        override fun resolve(call: PluginCall) { resolveCameraPermission(call) }
        override fun rejectClosed(call: PluginCall) {
            call.reject("Camera plugin was destroyed", "CAMERA_DESTROYED")
        }
        override fun rejectFailure(call: PluginCall, error: RuntimeException) {
            call.reject("Camera permission request failed", "CAMERA_PERMISSION_FAILED", error)
        }
    })
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
    private var shutterSound: android.media.MediaActionSound? = null
    private data class SensorExposure(val preset: String, val iso: Int? = null, val nanos: Long? = null)
    private data class SensorObservation(val cameraId: String, val capture: TotalCaptureResult, val sequence: Long)
    private var observedSensor: SensorObservation? = null
    private var sensorSequence = 0L
    private var confirmedSensor: SensorExposure? = null
    private var sensorRequestId = 0L
    private val sensorDelivery = Handler(Looper.getMainLooper())

    private val frameDelivery = Handler(Looper.getMainLooper())
    private var previewEpoch = 0L
    private var lastFrameEventNanos = 0L
    private var firstFrameEpoch = -1L
    private var firstFrameReady: (() -> Unit)? = null
    private var firstFrameTraceCookie = 0

    // "photo" binds Preview + ImageCapture; "video" also binds VideoCapture.
    private var captureMode = "photo"
    private data class VideoConfig(val quality: Quality, val bitrate: Int?, val frameRate: Int?)
    private var boundVideoConfig: VideoConfig? = null
    /** What Video mode pre-binds: setCaptureMode's quality, bitrate and frame rate, so a recording
     * started with the same options starts without another rebind. */
    private var modeVideoConfig = VideoConfig(Quality.HIGHEST, null, null)

    // Every capturePhoto call settles exactly once, including after the preview stops.
    private inner class CaptureTicket(val call: PluginCall, val executor: ExecutorService) {
        private val settled = java.util.concurrent.atomic.AtomicBoolean(false)
        @Volatile var cancelled = false
        @Volatile var delivered = false
        fun resolve(result: JSObject) {
            if (!settled.compareAndSet(false, true)) return
            call.resolve(result)
            captureSettled(this)
        }
        fun reject(message: String?, code: String, error: Exception? = null, data: JSObject? = null) {
            if (!settled.compareAndSet(false, true)) return
            call.reject(message, code, error, data)
            captureSettled(this)
        }
    }
    private val captureLock = Any()
    private val inflightCaptures = mutableSetOf<CaptureTicket>()
    private val retiredExecutors = mutableSetOf<ExecutorService>()
    private val captureDelivery = Handler(Looper.getMainLooper())

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

    override fun load() {
        super.load()
        try { shutterSound = android.media.MediaActionSound().apply { load(android.media.MediaActionSound.SHUTTER_CLICK) } }
        catch (error: RuntimeException) { android.util.Log.w("ElizaCamera", "Shutter sound unavailable", error) }
        // Prewarm CameraX so the first startPreview does not pay provider initialization.
        cameraProviderFuture = runCatching { ProcessCameraProvider.getInstance(context) }.getOrNull()
    }

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
            // The preview stream runs at CameraX's default rate here; recording honors frameRate.
            if (!call.data.isNull("frameRate")) {
                call.reject("Android does not support a preview frame rate; set frameRate when recording", "INVALID_OPTIONS")
                return@runOnUiThread
            }
            stopPreviewInternal()
            pendingPreviewCall = call
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                android.os.Trace.beginAsyncSection(FIRST_FRAME_TRACE, ++firstFrameTraceCookie)
            }
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

    // Resolves on the first completed camera capture after settings restoration, not on bind.
    private fun startPreviewInternal(call: PluginCall) {
        val deviceId = call.getString("deviceId")
        val direction = call.getString("direction") ?: "back"
        val resObj = call.getObject("resolution")
        val width = resObj?.getInteger("width") ?: 1920
        val height = resObj?.getInteger("height") ?: 1080
        val mirror = call.getBoolean("mirror") ?: (direction == "front")
        val epoch = previewEpoch
        val traceCookie = firstFrameTraceCookie

        currentPreviewWidth = width
        currentPreviewHeight = height

        var frameSeen = false
        var restored = false
        val timeout = Runnable {
            if (pendingPreviewCall === call && previewEpoch == epoch && !frameSeen) {
                failPreview(call, IllegalStateException("No camera frame arrived within ${FIRST_FRAME_TIMEOUT_MS} ms"),
                    "CAMERA_START_TIMEOUT", "Camera did not deliver a frame in time")
            }
        }
        fun settle() {
            if (!frameSeen || !restored || pendingPreviewCall !== call || previewEpoch != epoch) return
            val owner = camera ?: return
            pendingPreviewCall = null
            call.resolve(cameraReceipt(owner, width, height, if (direction == "front") "front" else "back"))
        }

        try {
            require(deviceId != null || direction == "front" || direction == "back") { "Camera direction must be front or back" }
            require(width > 0 && height > 0) { "Preview dimensions must be positive" }
            cameraExecutor = Executors.newSingleThreadExecutor()
            frameDelivery.postDelayed(timeout, FIRST_FRAME_TIMEOUT_MS)

            // Reuse the provider future started in load(); a failed future is replaced on the next start.
            val providerFuture = cameraProviderFuture
                ?: ProcessCameraProvider.getInstance(context).also { cameraProviderFuture = it }

            providerFuture.addListener({
                if (pendingPreviewCall !== call || destroyed) return@addListener
                try {
                    val provider = try {
                        providerFuture.get()
                    } catch (error: Exception) {
                        if (cameraProviderFuture === providerFuture) cameraProviderFuture = null
                        throw error
                    }
                    cameraProvider = provider
                    // A deviceId is one of the ids getDevices returns and wins over direction.
                    val target = deviceId?.let { id ->
                        provider.availableCameraInfos.firstOrNull { cameraIdOf(it) == id }
                            ?: throw CameraSettingException("INVALID_OPTIONS", "Unknown camera deviceId $id")
                    }
                    val boundDirection = when (target?.lensFacing) {
                        null -> direction
                        CameraSelector.LENS_FACING_FRONT -> "front"
                        CameraSelector.LENS_FACING_BACK -> "back"
                        else -> "external"
                    }
                    val mirror = call.getBoolean("mirror") ?: (boundDirection == "front")

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

                    currentDirection = boundDirection
                    currentCameraSelector = when {
                        target != null -> target.cameraSelector
                        direction == "front" -> CameraSelector.DEFAULT_FRONT_CAMERA
                        else -> CameraSelector.DEFAULT_BACK_CAMERA
                    }

                    val previewBuilder = Preview.Builder().setResolutionSelector(resolutionSelector)
                    observeCameraFrames(previewBuilder, epoch)
                    preview = previewBuilder.build()
                        .also {
                            it.setSurfaceProvider(previewView?.surfaceProvider)
                        }

                    val captureSelector = ResolutionSelector.Builder()
                        .setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
                        .setResolutionStrategy(ResolutionStrategy.HIGHEST_AVAILABLE_STRATEGY)
                        .build()
                    // Keep the fast shutter path while capturing at the highest supported size.
                    imageCapture = ImageCapture.Builder()
                        .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                        .setResolutionSelector(captureSelector)
                        .setFlashMode(flashModeFromSetting(currentSettings["flash"] as? String ?: "off"))
                        .build()

                    // A started preview is always in photo mode; setCaptureMode adds VideoCapture.
                    captureMode = "photo"
                    firstFrameEpoch = epoch
                    firstFrameReady = {
                        frameDelivery.removeCallbacks(timeout)
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                            android.os.Trace.endAsyncSection(FIRST_FRAME_TRACE, traceCookie)
                        }
                        frameSeen = true
                        settle()
                    }

                    val owner = bindUseCases(provider)

                    restoreCameraSettings(owner, {
                        restored = true
                        settle()
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

    /** Report the sizes CameraX bound, upright, rather than the requested size. */
    private fun putBoundSizes(result: JSObject) {
        fun upright(info: ResolutionInfo?): JSObject? = info?.let {
            val turned = it.rotationDegrees % 180 != 0
            JSObject().apply {
                put("width", if (turned) it.resolution.height else it.resolution.width)
                put("height", if (turned) it.resolution.width else it.resolution.height)
            }
        }
        upright(preview?.resolutionInfo)?.let { result.put("previewSize", it) }
        upright(imageCapture?.resolutionInfo)?.let { result.put("captureSize", it) }
    }

    private fun cameraReceipt(owner: Camera, width: Int, height: Int, deviceId: String): JSObject {
        val info = owner.cameraInfo
        val bounds = info.zoomState.value
        val hasFlash = info.hasFlashUnit()
        val flash = currentSettings["flash"] as? String ?: "off"
        return JSObject().apply {
            put("width", width)
            put("height", height)
            put("deviceId", deviceId)
            putBoundSizes(this)
            put("minZoom", (bounds?.minZoomRatio ?: 1f).toDouble())
            put("maxZoom", (bounds?.maxZoomRatio ?: 1f).toDouble())
            put("zoom", ((currentSettings["zoom"] as? Number)?.toFloat() ?: 1f).toDouble())
            put("hasFlash", hasFlash)
            put("flash", if (hasFlash && flash != "off") "on" else "off")
        }
    }

    // Binds Preview + ImageCapture, plus VideoCapture only in video mode.
    private fun bindUseCases(provider: ProcessCameraProvider): Camera {
        if (captureMode == "video") {
            if (videoCapture == null || boundVideoConfig != modeVideoConfig) {
                val config = modeVideoConfig
                videoCapture = buildVideoCapture(config)
                boundVideoConfig = config
            }
        } else {
            videoCapture = null
            boundVideoConfig = null
        }
        provider.unbindAll()
        val owner = activity as LifecycleOwner
        val video = videoCapture
        val bound = if (video == null) {
            provider.bindToLifecycle(owner, currentCameraSelector, requireNotNull(preview), requireNotNull(imageCapture))
        } else {
            provider.bindToLifecycle(owner, currentCameraSelector, requireNotNull(preview), requireNotNull(imageCapture), video)
        }
        camera = bound
        return bound
    }

    /** A recording's (or Video mode's) quality option; "highest" when absent. */
    private fun recordingQuality(call: PluginCall): Quality =
        when (if (call.data.has("quality")) call.getString("quality") else "highest") {
            "low" -> Quality.SD
            "medium" -> Quality.HD
            "high" -> Quality.FHD
            "highest" -> Quality.HIGHEST
            else -> throw IllegalArgumentException("Unknown recording quality")
        }

    private fun buildVideoCapture(config: VideoConfig): VideoCapture<Recorder> {
        val selector = if (config.quality == Quality.HIGHEST) QualitySelector.from(config.quality)
            else QualitySelector.from(config.quality, FallbackStrategy.lowerQualityOrHigherThan(config.quality))
        val recorder = Recorder.Builder().setQualitySelector(selector)
        config.bitrate?.let { recorder.setTargetVideoEncodingBitRate(it) }
        val captureBuilder = VideoCapture.Builder(recorder.build())
        config.frameRate?.let { captureBuilder.setTargetFrameRate(Range(it, it)) }
        return captureBuilder.build()
    }

    @PluginMethod
    fun setCaptureMode(call: PluginCall) {
        val mode = (call.data.opt("mode") as? String)?.takeIf { it == "photo" || it == "video" }
        if (mode == null) {
            call.reject("mode must be photo or video", "INVALID_ARGUMENT")
            return
        }
        // Video mode binds VideoCapture for the options the recordings will ask for.
        val videoConfig = try {
            VideoConfig(
                recordingQuality(call),
                positiveRecordingOption(call, "bitrate", Int.MAX_VALUE.toDouble() + 1, true)?.toInt(),
                positiveRecordingOption(call, "frameRate", Int.MAX_VALUE.toDouble() + 1, true)?.toInt(),
            )
        } catch (error: IllegalArgumentException) {
            call.reject(error.message, "INVALID_OPTIONS", error)
            return
        }
        activity.runOnUiThread {
            val provider = cameraProvider
            if (destroyed) {
                call.reject("Camera plugin was destroyed", "CAMERA_DESTROYED")
            } else if (recordingSession != null || recordingPermissionCalls.isNotEmpty()) {
                call.reject("Stop the recording before changing capture mode", "RECORDING_BUSY")
            } else if (pendingPreviewCall != null || switchingCamera) {
                call.reject("Camera settings are being restored", "CAMERA_NOT_READY")
            } else if (provider == null || camera == null) {
                call.reject("Camera preview is not active", "CAMERA_INACTIVE")
            } else if (mode == captureMode && (mode == "photo" || videoConfig == boundVideoConfig)) {
                if (mode == "video") modeVideoConfig = videoConfig
                call.resolve()
            } else {
                // Shares the switch gate so camera switches, recordings and settings wait for the rebind.
                switchingCamera = true
                val previous = captureMode
                val previousVideo = modeVideoConfig
                try {
                    captureMode = mode
                    if (mode == "video") modeVideoConfig = videoConfig
                    val owner = bindUseCases(provider)
                    restoreCameraSettings(owner, {
                        call.resolve()
                        finishCameraSwitch()
                    }, { error ->
                        call.reject("Failed to restore camera settings", "CAPTURE_MODE_ERROR", error)
                        finishCameraSwitch()
                    })
                } catch (error: Exception) {
                    // error-policy:J1 an unsupported use-case combination restores the previous mode.
                    captureMode = previous
                    modeVideoConfig = previousVideo
                    val recovered = try {
                        bindUseCases(provider)
                    } catch (ignored: Exception) {
                        null
                    }
                    if (recovered == null) {
                        // Neither mode could be bound: the preview is released, which the caller
                        // must show (PREVIEW_STOPPED and an error event), not just this failure.
                        call.reject("Camera preview stopped: ${error.message}", "PREVIEW_STOPPED", error)
                        stopPreviewInternal()
                        notifyListeners("error", JSObject().apply {
                            put("code", "PREVIEW_STOPPED")
                            put("message", "Camera preview stopped: ${error.message}")
                        })
                        finishCameraSwitch()
                    } else {
                        call.reject("Failed to change capture mode: ${error.message}", "CAPTURE_MODE_ERROR", error)
                        restoreCameraSettings(recovered, { finishCameraSwitch() }, { finishCameraSwitch() })
                    }
                }
            }
        }
    }

    private fun failPreview(call: PluginCall, error: Exception, code: String = "PREVIEW_ERROR", message: String = "Failed to start preview") {
        if (pendingPreviewCall !== call) return
        pendingPreviewCall = null
        stopPreviewInternal()
        if (error is CameraSettingException && error.code == "INVALID_OPTIONS") {
            call.reject(error.message, error.code, error)
            return
        }
        notifyListeners("error", JSObject().apply {
            put("code", code)
            put("message", "$message: ${error.message}")
        })
        call.reject(message, code, error)
    }

    @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
    private fun cameraIdOf(info: CameraInfo): String = Camera2CameraInfo.from(info).cameraId

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
        firstFrameEpoch = -1L
        firstFrameReady = null
        lastFrameEventNanos = 0L
        observedFocus = null
        observedSensor = null

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

        // In-flight captures keep their executor until CameraX reports them.
        cameraExecutor?.let { retireExecutor(it) }
        cameraExecutor = null

        preview = null
        imageCapture = null
        videoCapture = null
        boundVideoConfig = null
        camera = null
    }

    private fun retireExecutor(executor: ExecutorService) {
        val pending = synchronized(captureLock) {
            val tickets = inflightCaptures.filter { it.executor === executor }
            if (tickets.isNotEmpty()) retiredExecutors.add(executor)
            tickets
        }
        if (pending.isEmpty()) {
            executor.shutdown()
            return
        }
        pending.forEach { it.cancelled = true }
        captureDelivery.postDelayed({
            // A delivered capture is already settling on its executor.
            pending.filter { !it.delivered }.forEach {
                it.reject("Camera stopped before the photo was delivered", "CAPTURE_CANCELLED")
            }
        }, CAPTURE_SETTLE_TIMEOUT_MS)
    }

    private fun captureSettled(ticket: CaptureTicket) {
        val retired = synchronized(captureLock) {
            inflightCaptures.remove(ticket)
            val executor = ticket.executor
            if (executor in retiredExecutors && inflightCaptures.none { it.executor === executor }) {
                retiredExecutors.remove(executor)
                executor
            } else null
        }
        retired?.shutdown()
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
            if (call.getString("deviceId") != null) {
                call.reject("Android switches cameras by direction; pass deviceId to startPreview", "INVALID_OPTIONS")
                finishCameraSwitch()
                return@runOnUiThread
            }
            val direction = call.getString("direction")
                ?: if (currentDirection == "back") "front" else "back"
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
                // Flash and zoom belong to the old lens; a switch always starts the new lens
                // at flash off and 1x, so they are never validated against it.
                // A tap or manual focus lock belongs to the previous lens. The front
                // camera may be fixed-focus and must start with its own supported mode.
                val targetFocus = defaultFocus(targetInfo)
                validateFocus(targetInfo, targetFocus)
                confirmedSensor?.let { validateSensorExposure(targetInfo, it) }
                confirmedFocus = null
                currentSettings["focusMode"] = targetFocus.preset
                currentSettings["flash"] = "off"
                currentSettings["zoom"] = 1.0f
                imageCapture?.flashMode = ImageCapture.FLASH_MODE_OFF
                currentDirection = direction
                currentCameraSelector = targetSelector

                previewView?.scaleX = if (mirror) -1f else 1f

                // Keeps the current capture mode (photo or video).
                val owner = bindUseCases(provider)

                restoreCameraSettings(owner, {
                    call.resolve(cameraReceipt(owner, currentPreviewWidth, currentPreviewHeight, direction))
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
        val optionError = validatePhotoOptions(call.data)
        if (optionError != null) {
            call.reject(optionError, "INVALID_ARGUMENT")
            return
        }
        val saveToGallery = call.getBoolean("saveToGallery") ?: false
        if (saveToGallery && Build.VERSION.SDK_INT < Build.VERSION_CODES.Q &&
            getPermissionState("storage") != com.getcapacitor.PermissionState.GRANTED) {
            activity.runOnUiThread { requestPermissionForAlias("storage", call, "handlePhotoStoragePermission") }
            return
        }
        // Admission runs on the UI thread so it is ordered with stopPreview and rebinds.
        activity.runOnUiThread { startPhotoCapture(call) }
    }

    // Capture never consults focus or settings gates: a tap-to-focus action in flight does not
    // delay or reject it, and CAPTURE_MODE_MINIMIZE_LATENCY does not run an AF trigger.
    private fun startPhotoCapture(call: PluginCall) {
        val imgCapture = imageCapture
        val executor = cameraExecutor
        if (destroyed || imgCapture == null || executor == null) {
            call.reject("Camera not ready", "CAMERA_INACTIVE")
            return
        }
        val ticket = CaptureTicket(call, executor)
        synchronized(captureLock) { inflightCaptures.add(ticket) }
        try {
            // Apply flash mode for this capture.
            imgCapture.flashMode = flashModeFromSetting(currentSettings["flash"] as? String ?: "off")
            if (call.getBoolean("thumbnailOnly") ?: false) {
                captureToGallery(imgCapture, ticket, call.getBoolean("exifOrientation") ?: false)
            } else {
                captureProcessed(imgCapture, ticket)
            }
        } catch (e: Exception) {
            // error-policy:J1 synchronous capture admission failures settle the owning call.
            ticket.reject("Photo capture failed: ${e.message}", "CAPTURE_ERROR", e)
        }
    }

    private fun captureFailed(ticket: CaptureTicket, exception: ImageCaptureException) {
        if (ticket.cancelled) {
            ticket.reject("Camera stopped before the photo was captured", "CAPTURE_CANCELLED", exception)
            return
        }
        notifyListeners("error", JSObject().apply {
            put("code", "CAPTURE_ERROR")
            put("message", "Photo capture failed: ${exception.message}")
        })
        ticket.reject("Photo capture failed: ${exception.message}", "CAPTURE_ERROR", exception)
    }

    // thumbnailOnly: CameraX writes the JPEG straight into MediaStore (DCIM/Camera); only a
    // small oriented thumbnail crosses the bridge.
    /** A real saved-photo shutter follows ringer, DND and system volume; internal frame reads stay silent. */
    private fun playShutterFeedback() {
        if (destroyed) return
        try {
        val audio = context.getSystemService(android.media.AudioManager::class.java) ?: return
        val notifications = context.getSystemService(android.app.NotificationManager::class.java) ?: return
        if (audio.ringerMode != android.media.AudioManager.RINGER_MODE_NORMAL ||
            audio.isStreamMute(android.media.AudioManager.STREAM_SYSTEM) ||
            audio.getStreamVolume(android.media.AudioManager.STREAM_SYSTEM) == 0 ||
            notifications.currentInterruptionFilter != android.app.NotificationManager.INTERRUPTION_FILTER_ALL) return
        shutterSound?.play(android.media.MediaActionSound.SHUTTER_CLICK)
        } catch (error: RuntimeException) {
            // error-policy:J1 optional sound must never fail or repeat a photo capture.
            android.util.Log.w("ElizaCamera", "Shutter feedback unavailable", error)
        }
    }

    private fun captureToGallery(imgCapture: ImageCapture, ticket: CaptureTicket, includeExif: Boolean) {
        val resolver = context.contentResolver
        val stamp = java.text.SimpleDateFormat("yyyyMMdd_HHmmss_SSS", Locale.US).format(Date())
        val values = galleryMediaValues("IMG_$stamp.jpg", "image/jpeg", pending = false)
        val options = ImageCapture.OutputFileOptions.Builder(resolver, MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values).build()
        imgCapture.takePicture(options, ticket.executor, object : ImageCapture.OnImageSavedCallback {
            override fun onCaptureStarted() { playShutterFeedback() }
            override fun onImageSaved(outputFileResults: ImageCapture.OutputFileResults) {
                ticket.delivered = true
                val uri = outputFileResults.savedUri
                try {
                    val saved = requireNotNull(uri) { "CameraX did not report the gallery URI" }
                    ticket.resolve(galleryPhotoReceipt(saved, includeExif))
                } catch (e: Exception) {
                    // error-policy:J1 the photo is in the gallery; report its URI with the failure.
                    ticket.reject("Photo processing failed: ${e.message}", "PHOTO_PROCESSING_FAILED", e, JSObject().apply {
                        uri?.let { put("path", it.toString()) }
                    })
                }
            }

            override fun onError(exception: ImageCaptureException) {
                ticket.delivered = true
                captureFailed(ticket, exception)
            }
        })
    }

    private fun galleryPhotoReceipt(uri: Uri, includeExif: Boolean): JSObject {
        val resolver = context.contentResolver
        val exif = resolver.openInputStream(uri)?.use { ExifInterface(it) }
            ?: throw IllegalStateException("Saved photo is not readable")
        val orientation = exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        val sourceWidth = bounds.outWidth
        val sourceHeight = bounds.outHeight
        require(sourceWidth > 0 && sourceHeight > 0) { "Saved photo has no readable dimensions" }
        val swapped = orientation == ExifInterface.ORIENTATION_ROTATE_90 ||
            orientation == ExifInterface.ORIENTATION_ROTATE_270 ||
            orientation == ExifInterface.ORIENTATION_TRANSPOSE ||
            orientation == ExifInterface.ORIENTATION_TRANSVERSE
        var sample = 1
        while (maxOf(sourceWidth, sourceHeight) / (sample * 2) >= THUMBNAIL_EDGE) sample *= 2
        val decodeOptions = BitmapFactory.Options().apply { inSampleSize = sample }
        var bitmap: Bitmap = resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, decodeOptions) }
            ?: throw IllegalStateException("Failed to decode saved photo")
        try {
            val longest = maxOf(bitmap.width, bitmap.height)
            if (longest > THUMBNAIL_EDGE) {
                val scale = THUMBNAIL_EDGE.toFloat() / longest
                val scaled = Bitmap.createScaledBitmap(bitmap,
                    maxOf(1, (bitmap.width * scale).roundToInt()), maxOf(1, (bitmap.height * scale).roundToInt()), true)
                if (scaled !== bitmap) bitmap.recycle()
                bitmap = scaled
            }
            bitmap = rotateBitmapByExif(bitmap, orientation)
            val output = ByteArrayOutputStream()
            check(bitmap.compress(Bitmap.CompressFormat.JPEG, 80, output)) { "Thumbnail encoder did not produce output" }
            return JSObject().apply {
                put("path", uri.toString())
                put("format", "jpeg")
                put("width", if (swapped) sourceHeight else sourceWidth)
                put("height", if (swapped) sourceWidth else sourceHeight)
                put("thumbnail", Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP))
                if (includeExif) put("exif", extractExifData(exif))
            }
        } finally {
            bitmap.recycle()
        }
    }

    // Default path: decode, optionally resize, re-encode and return base64 (plus an optional gallery copy).
    private fun captureProcessed(imgCapture: ImageCapture, ticket: CaptureTicket) {
        val call = ticket.call
        val quality = call.getFloat("quality") ?: 90f
        val format = call.getString("format") ?: "jpeg"
        val saveToGallery = call.getBoolean("saveToGallery") ?: false
        val targetWidth = call.getInt("width")
        val targetHeight = call.getInt("height")
        val includeExif = call.getBoolean("exifOrientation") ?: false

        // Use file-based capture for EXIF support (matches classic CameraCaptureManager pattern).
        val tempFile = File.createTempFile("eliza-snap-", ".jpg", context.cacheDir)
        val outputOptions = ImageCapture.OutputFileOptions.Builder(tempFile).build()

        imgCapture.takePicture(
            outputOptions,
            ticket.executor,
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(outputFileResults: ImageCapture.OutputFileResults) {
                    ticket.delivered = true
                    var bitmap: Bitmap? = null
                    try {
                        // Extract EXIF orientation before decoding.
                        val exif = ExifInterface(tempFile.absolutePath)
                        val orientation = exif.getAttributeInt(
                            ExifInterface.TAG_ORIENTATION,
                            ExifInterface.ORIENTATION_NORMAL
                        )

                        val bytes = tempFile.readBytes()
                        bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                            ?: throw IllegalStateException("Failed to decode captured image")

                        // Rotate based on EXIF orientation (like classic implementation).
                        bitmap = rotateBitmapByExif(bitmap, orientation)

                        // Each dimension is independently optional. Preserve the
                        // oriented source dimension that the caller omitted.
                        if (targetWidth != null || targetHeight != null) {
                            val width = targetWidth ?: bitmap.width
                            val height = targetHeight ?: bitmap.height
                            require(width.toLong() * height <= Int.MAX_VALUE / 4) {
                                "Requested image exceeds Android bitmap byte capacity"
                            }
                            val scaled = Bitmap.createScaledBitmap(bitmap, width, height, true)
                            if (scaled !== bitmap) bitmap.recycle()
                            bitmap = scaled
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
                        check(bitmap.compress(compressFormat, quality.toInt(), outputStream)) {
                            "Image encoder did not produce output"
                        }

                        val outputBytes = outputStream.toByteArray()
                        val base64 = Base64.encodeToString(outputBytes, Base64.NO_WRAP)

                        // Build EXIF metadata if requested.
                        val exifData = if (includeExif) extractExifData(exif) else null

                        val finalWidth = bitmap.width
                        val finalHeight = bitmap.height
                        // Finish fallible metadata work before publishing the external effect.
                        // An unscaled JPEG saves the camera's own file with its EXIF and full
                        // encoder quality; a re-encoded image gets the camera's tags copied over.
                        val galleryPath = if (saveToGallery) {
                            val galleryBytes = if (format == "jpeg" && targetWidth == null && targetHeight == null) bytes
                                else withCameraExif(outputBytes, exif, format)
                            saveImageToGallery(galleryBytes, format)
                        } else null

                        ticket.resolve(JSObject().apply {
                            put("base64", base64)
                            put("format", format)
                            put("width", finalWidth)
                            put("height", finalHeight)
                            galleryPath?.let { put("path", it) }
                            exifData?.let { put("exif", it) }
                        })
                    } catch (e: GalleryImageWriteException) {
                        ticket.reject(e.message, "GALLERY_WRITE_FAILED", e, JSObject().apply {
                            e.uri?.let { put("path", it.toString()) }
                            put("cleanupFailed", e.cleanupFailed)
                        })
                    } catch (e: Exception) {
                        // error-policy:J1 capture/encoding failures reject the bridge call.
                        ticket.reject("Photo processing failed: ${e.message}", "PHOTO_PROCESSING_FAILED", e)
                    } finally {
                        bitmap?.recycle()
                        tempFile.delete()
                    }
                }

                override fun onError(exception: ImageCaptureException) {
                    ticket.delivered = true
                    tempFile.delete()
                    captureFailed(ticket, exception)
                }
            }
        )
    }

    private fun validatePhotoOptions(options: org.json.JSONObject): String? {
        for (key in options.keys()) {
            val value = options.opt(key)
            val valid = when (key) {
                "format" -> value is String && value in setOf("jpeg", "png", "webp")
                "quality" -> value is Number && value.toDouble().isFinite() && value.toDouble() in 0.0..100.0
                "width", "height" -> value is Number && value.toDouble().isFinite() &&
                    value.toDouble() >= 1.0 && value.toDouble() <= Int.MAX_VALUE.toDouble() &&
                    value.toDouble() == kotlin.math.floor(value.toDouble())
                "saveToGallery", "exifOrientation", "thumbnailOnly" -> value is Boolean
                else -> return "Unknown photo option: $key"
            }
            if (!valid) return "Invalid photo option: $key"
        }
        if (options.opt("thumbnailOnly") == true) {
            if (options.opt("saveToGallery") != true) return "thumbnailOnly requires saveToGallery: true"
            if (options.has("width") || options.has("height")) return "thumbnailOnly cannot be combined with width or height"
            if (options.has("format") && options.opt("format") != "jpeg") return "thumbnailOnly saves JPEG only"
            if (options.has("quality")) return "thumbnailOnly uses the camera JPEG quality; quality is not supported"
        }
        val width = (options.opt("width") as? Number)?.toLong() ?: 1L
        val height = (options.opt("height") as? Number)?.toLong() ?: 1L
        if (width * height > Int.MAX_VALUE / 4) return "Requested image exceeds Android bitmap byte capacity"
        return null
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

    /** Copy the camera's capture tags onto re-encoded bytes, which are upright. GPS is never copied. */
    private fun withCameraExif(encoded: ByteArray, source: ExifInterface, format: String): ByteArray {
        val file = File.createTempFile("eliza-exif-", ".$format", context.cacheDir)
        try {
            file.writeBytes(encoded)
            val target = ExifInterface(file.absolutePath)
            for (tag in copiedExifTags) source.getAttribute(tag)?.let { target.setAttribute(tag, it) }
            target.setAttribute(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL.toString())
            target.saveAttributes()
            return file.readBytes()
        } finally {
            file.delete()
        }
    }

    private val copiedExifTags = listOf(
        ExifInterface.TAG_MAKE, ExifInterface.TAG_MODEL, ExifInterface.TAG_SOFTWARE,
        ExifInterface.TAG_DATETIME, ExifInterface.TAG_DATETIME_ORIGINAL, ExifInterface.TAG_DATETIME_DIGITIZED,
        ExifInterface.TAG_OFFSET_TIME, ExifInterface.TAG_OFFSET_TIME_ORIGINAL, ExifInterface.TAG_OFFSET_TIME_DIGITIZED,
        ExifInterface.TAG_SUBSEC_TIME, ExifInterface.TAG_SUBSEC_TIME_ORIGINAL, ExifInterface.TAG_SUBSEC_TIME_DIGITIZED,
        ExifInterface.TAG_EXPOSURE_TIME, ExifInterface.TAG_F_NUMBER, ExifInterface.TAG_APERTURE_VALUE,
        ExifInterface.TAG_PHOTOGRAPHIC_SENSITIVITY, ExifInterface.TAG_EXPOSURE_BIAS_VALUE,
        ExifInterface.TAG_EXPOSURE_PROGRAM, ExifInterface.TAG_METERING_MODE, ExifInterface.TAG_FLASH,
        ExifInterface.TAG_FOCAL_LENGTH, ExifInterface.TAG_FOCAL_LENGTH_IN_35MM_FILM, ExifInterface.TAG_WHITE_BALANCE,
        ExifInterface.TAG_LENS_MAKE, ExifInterface.TAG_LENS_MODEL,
    )

    @PermissionCallback
    private fun handlePhotoStoragePermission(call: PluginCall) {
        if (getPermissionState("storage") != com.getcapacitor.PermissionState.GRANTED) {
            call.reject("Storage permission is required for gallery photos on this Android version", "PERMISSION_DENIED")
        } else capturePhoto(call)
    }

    // Every API level writes through MediaStore into DCIM/Camera and returns a content:// URI.
    private fun saveImageToGallery(bytes: ByteArray, format: String): String =
        GalleryImageWriter(context.contentResolver).save(bytes, format).toString()

    // ---- Video Recording ----

    @PluginMethod
    fun startRecording(call: PluginCall) {
        activity.runOnUiThread {
            if (destroyed) {
                call.reject("Camera plugin was destroyed", "CAMERA_DESTROYED")
            } else if (switchingCamera || pendingPreviewCall != null) {
                call.reject("Camera settings are being restored", "CAMERA_NOT_READY")
            } else if (recordingSession != null || recordingPermissionCalls.isNotEmpty()) {
                call.reject("A recording is already starting, recording or finalizing", "RECORDING_BUSY")
            } else if (camera == null || cameraProvider == null) {
                call.reject("Camera not ready", "CAMERA_NOT_READY")
            } else if ((call.getBoolean("audio") ?: true) &&
                getPermissionState("microphone") != com.getcapacitor.PermissionState.GRANTED) {
                recordingPermissionCalls.add(call)
                requestPermissionForAlias("microphone", call, "handleMicPermissionForRecording")
            } else {
                continueRecordingAdmission(call)
            }
        }
    }

    private fun needsRecordingStorage(call: PluginCall): Boolean =
        (call.getBoolean("saveToGallery") ?: false) && Build.VERSION.SDK_INT < Build.VERSION_CODES.Q &&
            getPermissionState("storage") != com.getcapacitor.PermissionState.GRANTED

    // Android 9 and older need storage permission to publish a gallery recording in DCIM/Camera.
    private fun continueRecordingAdmission(call: PluginCall) {
        if (needsRecordingStorage(call)) {
            recordingPermissionCalls.add(call)
            requestPermissionForAlias("storage", call, "handleStoragePermissionForRecording")
        } else {
            startRecordingInternal(call)
        }
    }

    @PermissionCallback
    private fun handleMicPermissionForRecording(call: PluginCall) {
        activity.runOnUiThread {
            if (!recordingPermissionCalls.remove(call)) return@runOnUiThread
            if (getPermissionState("microphone") != com.getcapacitor.PermissionState.GRANTED) {
                call.reject("Microphone permission denied for the requested audio recording", "MICROPHONE_DENIED")
            } else {
                continueRecordingAdmission(call)
            }
        }
    }

    @PermissionCallback
    private fun handleStoragePermissionForRecording(call: PluginCall) {
        activity.runOnUiThread {
            if (!recordingPermissionCalls.remove(call)) return@runOnUiThread
            if (getPermissionState("storage") != com.getcapacitor.PermissionState.GRANTED) {
                call.reject("Storage permission is required for gallery recordings on this Android version", "PERMISSION_DENIED")
            } else {
                startRecordingInternal(call)
            }
        }
    }

    @android.annotation.SuppressLint("MissingPermission")
    private fun startRecordingInternal(call: PluginCall) {
        if (switchingCamera || pendingPreviewCall != null) {
            call.reject("Camera settings are being restored", "CAMERA_NOT_READY")
            return
        }
        if (destroyed || camera == null || cameraProvider == null) {
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
            quality = recordingQuality(call)
        } catch (error: IllegalArgumentException) {
            // error-policy:J3 reject malformed recording options before native effects.
            call.reject(error.message, "INVALID_OPTIONS", error)
            return
        }
        val saveToGallery = call.getBoolean("saveToGallery") ?: false
        if (saveToGallery && Build.VERSION.SDK_INT < Build.VERSION_CODES.Q &&
            getPermissionState("storage") != com.getcapacitor.PermissionState.GRANTED) {
            call.reject("Storage permission is required for gallery recordings on this Android version", "PERMISSION_DENIED")
            return
        }
        val fileName = "VID_${UUID.randomUUID()}.mp4"
        val file = if (saveToGallery) null else File(context.cacheDir, fileName)
        val session = RecordingSession(call, file)
        recordingSession = session
        completedRecording = null
        completedRecordingError = null

        fun begin(capture: VideoCapture<Recorder>) {
            check(recordingSession === session && !session.stopping) { "Recording was cancelled before native settings completed" }
            val pending = if (saveToGallery) {
                // DCIM/Camera on every API level; Android 9 and older get an explicit public path.
                val builder = MediaStoreOutputOptions.Builder(context.contentResolver, MediaStore.Video.Media.EXTERNAL_CONTENT_URI)
                    .setContentValues(galleryMediaValues(fileName, "video/mp4", pending = false))
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
                            event.error == VideoRecordEvent.Finalize.ERROR_FILE_SIZE_LIMIT_REACHED ||
                            event.error == VideoRecordEvent.Finalize.ERROR_SOURCE_INACTIVE ||
                            event.error == VideoRecordEvent.Finalize.ERROR_INSUFFICIENT_STORAGE
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
        }

        val requested = VideoConfig(quality, bitrate?.toInt(), frameRate?.toInt())
        val bound = videoCapture
        if (bound != null && boundVideoConfig == requested) {
            // Video mode already bound a matching VideoCapture: start without a rebind.
            try {
                begin(bound)
            } catch (error: Exception) {
                // error-policy:J1 output admission errors settle the owning call; the preview stays bound.
                finishRecording(session, null, error)
            }
            return
        }
        val previousCapture = videoCapture
        try {
            val capture = buildVideoCapture(requested)
            val provider = requireNotNull(cameraProvider) { "Camera provider is unavailable" }
            provider.unbindAll()
            videoCapture = capture
            boundVideoConfig = requested
            camera = provider.bindToLifecycle(activity as LifecycleOwner, currentCameraSelector,
                requireNotNull(preview), requireNotNull(imageCapture), capture)
            restoreCameraSettings(requireNotNull(camera), {
                begin(capture)
            }, { error ->
                if (recordingSession === session) {
                    finishRecording(session, null, error)
                    stopPreviewInternal()
                }
            })
        } catch (error: Exception) {
            // error-policy:J1 synchronous CameraX admission errors settle the owning call.
            recoverFromRecordingStart(session, previousCapture, error)
        }
    }

    /**
     * A recording start failed after its rebind may have replaced the use cases. Bind the
     * previous ones again so the viewfinder stays live, then reject the start with its error.
     * When that also fails the preview is stopped and the start rejects PREVIEW_STOPPED, so
     * hosts know to offer a fresh preview start instead of a dead shutter.
     */
    private fun recoverFromRecordingStart(session: RecordingSession, previous: VideoCapture<Recorder>?, error: Exception) {
        if (recordingSession !== session) return
        val epoch = previewEpoch
        fun previewStopped(cause: Exception) {
            if (cause !== error) error.addSuppressed(cause)
            // The host stopped the preview meanwhile; that stop already settled the start.
            if (previewEpoch != epoch) {
                finishRecording(session, null, error)
                return
            }
            if (recordingSession === session) finishRecording(session, null, error, "PREVIEW_STOPPED")
            else notifyListeners("error", JSObject().apply {
                put("code", "PREVIEW_STOPPED")
                put("message", error.message)
            })
            stopPreviewInternal()
        }
        try {
            val provider = requireNotNull(cameraProvider) { "Camera provider is unavailable" }
            val prior = requireNotNull(previous) { "No previous video capture to restore" }
            provider.unbindAll()
            videoCapture = prior
            camera = provider.bindToLifecycle(activity as LifecycleOwner, currentCameraSelector,
                requireNotNull(preview), requireNotNull(imageCapture), prior)
            restoreCameraSettings(requireNotNull(camera), { finishRecording(session, null, error) }, { previewStopped(it) })
        } catch (rebindError: Exception) {
            // error-policy:J1 a failed rebind stops the preview and says so to the caller.
            previewStopped(rebindError)
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

    private fun finishRecording(session: RecordingSession, result: JSObject?, error: Exception?, code: String = "RECORDING_ERROR") {
        if (recordingSession !== session) return
        recordingSession = null
        // A failed cache recording is never returned, so nothing else would remove it. A
        // MediaStore output is left alone: it may hold a playable partial clip.
        if (error != null) session.file?.delete()
        if (!session.startSettled) {
            session.startSettled = true
            session.startCall.reject(
                if (code == "PREVIEW_STOPPED") "Recording did not start and the camera preview stopped" else "Recording did not start",
                code, error)
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
            put("code", code)
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

        if (settings.has("whiteBalance") || settings.has("exposureCompensation") || settings.has("zoom") || settings.has("flash") || settings.has("focusMode") || settings.has("exposureMode") || settings.has("iso") || settings.has("shutterSpeed")) {
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
                val sensor = if (settings.has("exposureMode") || settings.has("iso") || settings.has("shutterSpeed")) planSensorExposure(owner.cameraInfo, settings) else null
                validateExposureCombination(sensor ?: confirmedSensor, flash ?: currentSettings["flash"] as? String ?: "off", requestedEv ?: requestedExposureEv)
                val epoch = previewEpoch
                val failed: (Exception) -> Unit = { error -> call.reject("Camera control failed", "CAMERA_CONTROL_FAILED", error) }
                fun complete() {
                    if (sensor == null) {
                        applySettingsValues(settings)
                        call.resolve()
                    } else applySensorExposure(owner, epoch, sensor, { applied ->
                        confirmSensorExposure(applied, sensor)
                        applySettingsValues(settings)
                        call.resolve()
                    }, failed)
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
                    if (exposure == null) {
                        applyBatchZoom()
                        return
                    }
                    fun submitEv() {
                        awaitCameraControl(owner, epoch, owner.cameraControl.setExposureCompensationIndex(exposure.index), {
                            requestedExposureEv = requireNotNull(requestedEv)
                            currentSettings["exposureCompensation"] = exposure.appliedEv
                            applyBatchZoom()
                        }, failed)
                    }
                    val manual = confirmedSensor?.takeIf { it.preset == "manual" }
                    if (manual == null) submitEv()
                    else {
                        // CameraX's EV future requires an automatic AE state; it
                        // never completes while manual sensor AE is inactive.
                        val policy = if (sensor != null && sensor.preset != "manual") SensorExposure("continuous") else manual
                        applySensorExposure(owner, epoch, policy, { applied ->
                            confirmSensorExposure(applied, policy)
                            if (policy.preset != "manual") submitEv()
                            else {
                                // Preflight permits only the neutral EV request
                                // here. It is already confirmed and has no effect with AE off.
                                check(exposure.index == 0 && requestedExposureEv == 0.0)
                                applyBatchZoom()
                            }
                        }, failed)
                    }
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
            if (key !in setOf("exposureCompensation", "zoom", "flash", "focusMode", "exposureMode", "iso", "shutterSpeed")) currentSettings[key] = settings.get(key)
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
    // owning preview/switch/recording operation can report success. Values already at the camera's
    // default are skipped. Zoom and torch run in parallel with the Camera2 interop chain; the interop
    // steps stay sequential because each interop update cancels a pending one.
    @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
    private fun restoreCameraSettings(owner: Camera, ready: () -> Unit, failed: (Exception) -> Unit) {
        val epoch = previewEpoch
        val info = owner.cameraInfo
        val interop = Camera2CameraControl.from(owner.cameraControl)
        val preset = currentSettings["whiteBalance"] as? String ?: "auto"
        val zoom = (currentSettings["zoom"] as? Number)?.toFloat() ?: 1.0f
        val flash = currentSettings["flash"] as? String ?: "off"
        fun stillOwnsCamera() = !destroyed && camera === owner && previewEpoch == epoch

        var remaining = 3
        var settled = false
        fun branchFailed(error: Exception) {
            if (settled) return
            settled = true
            failed(error)
        }
        fun branchDone() {
            if (settled) return
            remaining--
            if (remaining > 0) return
            settled = true
            try {
                ready()
            } catch (error: Exception) {
                failed(error)
            }
        }

        val focus: FocusSetting
        val skipFocus: Boolean
        val releaseSensor: Boolean
        val skipEv: Boolean
        val sensor = confirmedSensor?.takeIf { it.preset != "continuous" }
        val confirmFlashPolicy = flash == "on" || flash == "auto"
        try {
            validateFlash(info, flash)
            requireNotNull(imageCapture) { "Camera capture is not ready" }.flashMode = flashModeFromSetting(flash)
            if (zoom != 1.0f) validateZoom(info, zoom)
            val current = interop.captureRequestOptions
            focus = restoredFocus(info)
            val afOverride = current.getCaptureRequestOption(CaptureRequest.CONTROL_AF_MODE)
            skipFocus = (afOverride == null || afOverride == focus.mode) &&
                (confirmedFocus == null || (focus.preset != "manual" && focus.mode == defaultFocus(info).mode))
            // A cancelled manual/locked request can leave Camera2 AE overrides alive across unbind/rebind.
            releaseSensor = current.getCaptureRequestOption(CaptureRequest.CONTROL_AE_MODE) != null ||
                current.getCaptureRequestOption(CaptureRequest.CONTROL_AE_LOCK) == true ||
                current.getCaptureRequestOption(CaptureRequest.SENSOR_SENSITIVITY) != null ||
                current.getCaptureRequestOption(CaptureRequest.SENSOR_EXPOSURE_TIME) != null
            skipEv = confirmedSensor?.preset == "manual" ||
                (requestedExposureEv == 0.0 && info.exposureState.exposureCompensationIndex == 0)
            val awbOverride = current.getCaptureRequestOption(CaptureRequest.CONTROL_AWB_MODE)
            val skipWhiteBalance = preset == "auto" && (awbOverride == null || awbOverride == CaptureRequest.CONTROL_AWB_MODE_AUTO)
            val chainNeeded = !skipWhiteBalance || releaseSensor || !skipEv || confirmFlashPolicy || !skipFocus || sensor != null
            if (!chainNeeded) {
                if (confirmedFocus != null) confirmFocus(info, focus)
                currentSettings["focusMode"] = focus.preset
                if (confirmedSensor?.preset != "manual") currentSettings["exposureCompensation"] = 0.0
            }

            // Branch 1: zoom.
            val zoomState = info.zoomState.value
            if (zoom == 1.0f && (zoomState == null || zoomState.zoomRatio == 1.0f)) branchDone()
            else awaitRestoredControl(owner, epoch, { owner.cameraControl.setZoomRatio(zoom) }, { branchDone() }, { branchFailed(it) })

            // Branch 2: torch.
            val torchOn = info.hasFlashUnit() && info.torchState.value == TorchState.ON
            if (flash != "torch" && !torchOn) branchDone()
            else awaitRestoredControl(owner, epoch, { owner.cameraControl.enableTorch(flash == "torch") }, { branchDone() }, { branchFailed(it) })

            // Branch 3: the sequential interop chain, skipped entirely when everything is at its default.
            if (!chainNeeded) {
                branchDone()
                return
            }
        } catch (error: Exception) {
            branchFailed(error)
            return
        }

        fun restoreSensor() {
            try {
                if (sensor == null) branchDone()
                else applySensorExposure(owner, epoch, sensor, { applied ->
                    confirmSensorExposure(applied, sensor)
                    branchDone()
                }, { branchFailed(it) })
            } catch (error: Exception) {
                branchFailed(error)
            }
        }
        fun restoreFocus() {
            try {
                if (skipFocus) {
                    if (confirmedFocus != null) confirmFocus(info, focus)
                    currentSettings["focusMode"] = focus.preset
                    restoreSensor()
                } else applyFocus(owner, epoch, focus, {
                    if (confirmedFocus != null) confirmFocus(info, focus)
                    currentSettings["focusMode"] = focus.preset
                    restoreSensor()
                }, { branchFailed(it) })
            } catch (error: Exception) {
                branchFailed(error)
            }
        }
        fun restoreFlashPolicy() {
            // ImageCapture's flash policy setter has no public future. A subsequent
            // Camera2 options update completes only after its session tag reaches a
            // capture, including the flash policy queued before it. Empty options
            // preserve existing interop settings such as white balance.
            try {
                if (!confirmFlashPolicy) restoreFocus()
                else awaitCameraControl(owner, epoch, interop.addCaptureRequestOptions(CaptureRequestOptions.Builder().build()),
                    { restoreFocus() }, { branchFailed(it) })
            } catch (error: Exception) {
                branchFailed(error)
            }
        }
        fun restoreEv() {
            try {
                if (skipEv) {
                    if (confirmedSensor?.preset != "manual") currentSettings["exposureCompensation"] = 0.0
                    restoreFlashPolicy()
                } else restoreExposure(owner, epoch, { restoreFlashPolicy() }, { branchFailed(it) })
            } catch (error: Exception) {
                branchFailed(error)
            }
        }
        fun releaseSensorOverrides() {
            try {
                if (!releaseSensor) restoreEv()
                else applySensorExposure(owner, epoch, SensorExposure("continuous"), { _ -> restoreEv() }, { branchFailed(it) })
            } catch (error: Exception) {
                branchFailed(error)
            }
        }
        // White balance always leads a needed chain (even for "auto"): its retry absorbs the
        // inactive transition CameraX queues during unbind/rebind before later interop steps run.
        fun restoreWhiteBalance(allowRebindRetry: Boolean) {
            try {
                val future = whiteBalanceFuture(owner, preset)
                val requestId = whiteBalanceRequestId
                future.addListener({
                    try {
                        future.get()
                        check(stillOwnsCamera()) { "Camera changed during white balance restoration" }
                    } catch (error: Exception) {
                        // Re-submit once after that transition, only if this request still owns
                        // the foreground camera. A newer preset, stop or switch must never be overwritten.
                        val cause = (error as? java.util.concurrent.ExecutionException)?.cause
                        if (allowRebindRetry && cause is CameraControl.OperationCanceledException &&
                            stillOwnsCamera() && whiteBalanceRequestId == requestId && isForeground()) {
                            restoreWhiteBalance(false)
                        } else branchFailed(error)
                        return@addListener
                    }
                    releaseSensorOverrides()
                }, ContextCompat.getMainExecutor(context))
            } catch (error: Exception) {
                branchFailed(error)
            }
        }
        restoreWhiteBalance(true)
    }

    private fun isForeground(): Boolean = (activity as? LifecycleOwner)?.lifecycle?.currentState
        ?.isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED) == true

    // Like awaitCameraControl, but re-submits once when the control was cancelled by the
    // inactive transition CameraX queues during unbind/rebind.
    private fun awaitRestoredControl(owner: Camera, epoch: Long, submit: () -> ListenableFuture<*>, ready: () -> Unit,
                                     failed: (Exception) -> Unit, allowRetry: Boolean = true) {
        val future = submit()
        future.addListener({
            val error = try {
                future.get()
                null
            } catch (failure: Exception) {
                failure
            }
            val owns = !destroyed && camera === owner && previewEpoch == epoch
            if (error == null) {
                if (!owns) failed(IllegalStateException("Camera changed before control completed"))
                else try {
                    ready()
                } catch (failure: Exception) {
                    failed(failure)
                }
            } else if (allowRetry && owns && isForeground() &&
                (error as? java.util.concurrent.ExecutionException)?.cause is CameraControl.OperationCanceledException) {
                try {
                    awaitRestoredControl(owner, epoch, submit, ready, failed, false)
                } catch (failure: Exception) {
                    failed(failure)
                }
            } else failed(error)
        }, ContextCompat.getMainExecutor(context))
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
        val released = retainedCaptureOptions(interop.captureRequestOptions, omitFocus = true).build()
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

    @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
    private fun retainedCaptureOptions(current: CaptureRequestOptions, omitFocus: Boolean = false, omitSensor: Boolean = false): CaptureRequestOptions.Builder {
        val builder = CaptureRequestOptions.Builder()
        fun <T> copy(key: CaptureRequest.Key<T>) {
            current.getCaptureRequestOption(key)?.let { builder.setCaptureRequestOption(key, it) }
        }
        copy(CaptureRequest.CONTROL_AWB_MODE)
        if (!omitFocus) copy(CaptureRequest.CONTROL_AF_MODE)
        copy(CaptureRequest.LENS_FOCUS_DISTANCE)
        if (!omitSensor) {
            copy(CaptureRequest.CONTROL_AE_MODE)
            copy(CaptureRequest.CONTROL_AE_LOCK)
            copy(CaptureRequest.SENSOR_SENSITIVITY)
            copy(CaptureRequest.SENSOR_EXPOSURE_TIME)
        }
        return builder
    }

    private fun validateExposureCombination(sensor: SensorExposure?, flash: String, ev: Double) {
        if (sensor?.preset == "manual" && (flash in setOf("on", "auto") || ev != 0.0)) {
            throw CameraSettingException("EXPOSURE_CONFLICT", "Manual exposure requires zero exposure compensation and flash off or torch")
        }
    }

    @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
    private fun validateSensorExposure(info: CameraInfo, sensor: SensorExposure) {
        val details = Camera2CameraInfo.from(info)
        if (sensor.preset == "manual") {
            val capabilities = details.getCameraCharacteristic(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES) ?: intArrayOf()
            val modes = details.getCameraCharacteristic(CameraCharacteristics.CONTROL_AE_AVAILABLE_MODES) ?: intArrayOf()
            if (CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR !in capabilities || CaptureRequest.CONTROL_AE_MODE_OFF !in modes) {
                throw CameraSettingException("EXPOSURE_UNSUPPORTED", "This camera does not support manual sensor exposure")
            }
            val isoRange = details.getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE)
            val timeRange = details.getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE)
            if (isoRange == null || timeRange == null) throw CameraSettingException("EXPOSURE_UNSUPPORTED", "This camera does not report manual sensor ranges")
            if (sensor.iso != null && !isoRange.contains(sensor.iso) || sensor.nanos != null && !timeRange.contains(sensor.nanos)) {
                throw CameraSettingException("EXPOSURE_OUT_OF_RANGE", "ISO or shutter speed is outside this camera's supported range")
            }
        } else if (sensor.preset == "auto" && details.getCameraCharacteristic(CameraCharacteristics.CONTROL_AE_LOCK_AVAILABLE) != true) {
            throw CameraSettingException("EXPOSURE_UNSUPPORTED", "This camera does not support single-shot exposure locking")
        }
    }

    @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
    private fun planSensorExposure(info: CameraInfo, settings: org.json.JSONObject): SensorExposure {
        val hasValues = settings.has("iso") || settings.has("shutterSpeed")
        val preset = if (settings.has("exposureMode")) settings.getString("exposureMode") else if (hasValues) "manual" else "continuous"
        if (hasValues && preset != "manual") throw CameraSettingException("EXPOSURE_CONFLICT", "ISO and shutter speed require manual exposure")
        validateSensorExposure(info, SensorExposure(preset))
        if (preset != "manual") return SensorExposure(preset)
        val observed = observedSensor?.takeIf { it.cameraId == Camera2CameraInfo.from(info).cameraId }?.capture
        val iso = if (settings.has("iso")) settings.getInt("iso") else observed?.get(CaptureResult.SENSOR_SENSITIVITY)
        val nanos = if (settings.has("shutterSpeed")) (settings.getDouble("shutterSpeed") * 1e9).toLong() else observed?.get(CaptureResult.SENSOR_EXPOSURE_TIME)
        if (iso == null || nanos == null) throw CameraSettingException("CAMERA_NOT_READY", "Completed sensor metadata is required before locking exposure")
        return SensorExposure(preset, iso, nanos).also { validateSensorExposure(info, it) }
    }

    private fun confirmSensorExposure(sensor: SensorExposure, requested: SensorExposure = sensor) {
        // Preserve the confirmed request across cameras; repeatedly restoring
        // quantized sensor results would accumulate rounding drift.
        confirmedSensor = requested
        currentSettings["exposureMode"] = sensor.preset
        if (sensor.preset == "manual") {
            currentSettings["iso"] = requireNotNull(sensor.iso)
            currentSettings["shutterSpeed"] = requireNotNull(sensor.nanos) / 1e9
        } else {
            currentSettings.remove("iso")
            currentSettings.remove("shutterSpeed")
        }
    }

    @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
    private fun applySensorExposure(owner: Camera, epoch: Long, sensor: SensorExposure, ready: (SensorExposure) -> Unit, failed: (Exception) -> Unit) {
        validateSensorExposure(owner.cameraInfo, sensor)
        val requestId = ++sensorRequestId
        val interop = Camera2CameraControl.from(owner.cameraControl)
        val options = retainedCaptureOptions(interop.captureRequestOptions, omitSensor = true)
            .setCaptureRequestOption(CaptureRequest.CONTROL_AE_LOCK, false)
        if (sensor.preset == "manual") {
            options.setCaptureRequestOption(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_OFF)
                .setCaptureRequestOption(CaptureRequest.SENSOR_SENSITIVITY, requireNotNull(sensor.iso))
                .setCaptureRequestOption(CaptureRequest.SENSOR_EXPOSURE_TIME, requireNotNull(sensor.nanos))
        }
        fun ownsRequest() = !destroyed && camera === owner && previewEpoch == epoch && sensorRequestId == requestId
        fun awaitCapture(locked: Boolean) {
            val after = sensorSequence
            val deadline = SystemClock.elapsedRealtime() + 15000L + (sensor.nanos ?: 0L) / 1_000_000L
            val poll = object : Runnable {
                override fun run() {
                    try {
                        check(ownsRequest()) { "Camera changed before exposure completed" }
                        val observation = observedSensor
                        val result = observation?.capture
                        val fresh = observation != null && observation.sequence > after && observation.cameraId == Camera2CameraInfo.from(owner.cameraInfo).cameraId
                        val aeMode = result?.get(CaptureResult.CONTROL_AE_MODE)
                        val aeState = result?.get(CaptureResult.CONTROL_AE_STATE)
                        val applied = fresh && when {
                            sensor.preset == "manual" -> aeMode == CaptureResult.CONTROL_AE_MODE_OFF &&
                                result?.request?.get(CaptureRequest.SENSOR_SENSITIVITY) == sensor.iso &&
                                result?.request?.get(CaptureRequest.SENSOR_EXPOSURE_TIME) == sensor.nanos &&
                                result?.get(CaptureResult.SENSOR_SENSITIVITY) != null && result.get(CaptureResult.SENSOR_EXPOSURE_TIME) != null
                            locked -> result?.get(CaptureResult.CONTROL_AE_LOCK) == true && aeState == CaptureResult.CONTROL_AE_STATE_LOCKED
                            sensor.preset == "auto" -> aeMode != null && aeMode != CaptureResult.CONTROL_AE_MODE_OFF && aeState in setOf(CaptureResult.CONTROL_AE_STATE_CONVERGED, CaptureResult.CONTROL_AE_STATE_FLASH_REQUIRED)
                            else -> aeMode != null && aeMode != CaptureResult.CONTROL_AE_MODE_OFF && result?.get(CaptureResult.CONTROL_AE_LOCK) != true
                        }
                        if (applied) {
                            if (sensor.preset == "auto" && !locked) {
                                awaitCameraControl(owner, epoch, interop.addCaptureRequestOptions(CaptureRequestOptions.Builder()
                                    .setCaptureRequestOption(CaptureRequest.CONTROL_AE_LOCK, true).build()), { awaitCapture(true) }, failed)
                            } else if (sensor.preset == "manual") {
                                ready(SensorExposure("manual", result!!.get(CaptureResult.SENSOR_SENSITIVITY), result.get(CaptureResult.SENSOR_EXPOSURE_TIME)))
                            } else ready(sensor)
                        } else {
                            check(SystemClock.elapsedRealtime() < deadline) { "Timed out waiting for completed exposure metadata" }
                            // Keep the cancellation check alive when preview frame callbacks are removed.
                            sensorDelivery.postDelayed(this, 20)
                        }
                    } catch (error: Exception) { failed(error) }
                }
            }
            poll.run()
        }
        awaitCameraControl(owner, epoch, interop.setCaptureRequestOptions(options.build()), {
            check(ownsRequest()) { "A newer exposure request superseded this mode" }
            awaitCapture(false)
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
            } else {
                val epoch = previewEpoch
                val failed: (Exception) -> Unit = { error -> call.reject("Camera exposure metering failed", "CAMERA_CONTROL_FAILED", error) }
                // A metering region belongs to automatic exposure, not manual sensor control.
                applySensorExposure(owner, epoch, SensorExposure("continuous"), { applied ->
                    confirmSensorExposure(applied)
                    awaitCameraControl(owner, epoch, owner.cameraControl.startFocusAndMetering(action), {
                        call.resolve()
                    }, failed)
                }, failed)
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
        if (confirmedSensor?.preset == "manual") {
            ready()
            return
        }
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
                    // The first completed capture of this preview epoch settles startPreview.
                    if (firstFrameEpoch == epoch) {
                        firstFrameEpoch = -1L
                        val notify = firstFrameReady
                        firstFrameReady = null
                        notify?.invoke()
                    }
                    // startPreview's resolve may have stopped or replaced this preview.
                    if (epoch != previewEpoch || destroyed || camera !== owner) return@post
                    result.get(CaptureResult.LENS_FOCUS_DISTANCE)?.let { distance ->
                        if (distance.isFinite()) observedFocus = FocusObservation(session.device.id, distance)
                    }
                    observedSensor = SensorObservation(session.device.id, result, ++sensorSequence)
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
    fun checkCameraPermission(call: PluginCall) {
        activity.runOnUiThread {
            if (destroyed) call.reject("Camera plugin was destroyed", "CAMERA_DESTROYED")
            else resolveCameraPermission(call)
        }
    }

    @PluginMethod
    fun requestCameraPermission(call: PluginCall) {
        activity.runOnUiThread {
            if (destroyed) {
                call.reject("Camera plugin was destroyed", "CAMERA_DESTROYED")
            } else if (getPermissionState("camera") == com.getcapacitor.PermissionState.GRANTED) {
                resolveCameraPermission(call)
            } else {
                cameraPermissionRequests.request(call)
            }
        }
    }

    @PermissionCallback
    private fun handleScopedCameraPermissionResult(call: PluginCall) {
        activity.runOnUiThread {
            // Destroy already rejected and retired its exact pending calls.
            cameraPermissionRequests.complete(call)
        }
    }

    private fun resolveCameraPermission(call: PluginCall) {
        call.resolve(JSObject().apply {
            put("camera", permissionString(getPermissionState("camera")))
        })
    }

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
            shutterSound?.release()
            shutterSound = null
            cameraPermissionRequests.close()
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
