// TODO: validate on device — checklist in ANDROID_CONSTRAINTS.md
//
// ScreenCaptureService — MediaProjection foreground service for screen frame capture.
//
// Requires:
//   - FOREGROUND_SERVICE, FOREGROUND_SERVICE_MEDIA_PROJECTION permissions in manifest
//   - Service declared with foregroundServiceType="mediaProjection|dataSync"
//   - User must approve the MediaProjection consent dialog (createScreenCaptureIntent)
//   - POST_NOTIFICATIONS permission (API 33+) for the required foreground notification
//
// MARK: - Contract (mirrors android-bridge.ts startMediaProjection / stopMediaProjection / captureFrame)
//
// startMediaProjection({ fps?, quality? }) — starts the VirtualDisplay + ImageReader pipeline.
// captureFrame() → { jpegBase64: string, width: number, height: number, timestampMs: number }
// stopMediaProjection() — tears down VirtualDisplay and MediaProjection.

package ai.elizaos.computeruse

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.IBinder
import android.util.Base64
import android.util.DisplayMetrics
import android.view.WindowManager
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

class ScreenCaptureService : Service() {

    companion object {
        const val ACTION_START = "ai.elizaos.computeruse.START_CAPTURE"
        const val ACTION_STOP = "ai.elizaos.computeruse.STOP_CAPTURE"
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_RESULT_DATA = "resultData"
        const val EXTRA_FPS = "fps"

        private const val CHANNEL_ID = "milady_screen_capture"
        private const val NOTIFICATION_ID = 0x4d43 // 'MC'

        // Frame ring-buffer shared with the Capacitor plugin bridge thread.
        @Volatile
        var latestFrame: CapturedFrame? = null
            private set

        @Volatile
        var isRunning: Boolean = false
            private set
    }

    data class CapturedFrame(
        val jpegBase64: String,
        val width: Int,
        val height: Int,
        val timestampMs: Long,
    )

    private var mediaProjection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var scheduler: ScheduledExecutorService? = null
    private var captureTask: ScheduledFuture<*>? = null

    // ── Service lifecycle ─────────────────────────────────────────────────────

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0)
                val resultData = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(EXTRA_RESULT_DATA)
                }
                val fps = intent.getIntExtra(EXTRA_FPS, 1)
                if (resultData != null) {
                    startForeground(NOTIFICATION_ID, buildNotification())
                    startCapture(resultCode, resultData, fps)
                }
            }
            ACTION_STOP -> {
                stopCapture()
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        stopCapture()
        super.onDestroy()
    }

    // ── Capture pipeline ──────────────────────────────────────────────────────

    private fun startCapture(resultCode: Int, resultData: Intent, fps: Int) {
        val metrics = DisplayMetrics()
        val wm = getSystemService(WINDOW_SERVICE) as WindowManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val display = display ?: return
            display.getRealMetrics(metrics)
        } else {
            @Suppress("DEPRECATION")
            wm.defaultDisplay.getRealMetrics(metrics)
        }

        val width = metrics.widthPixels
        val height = metrics.heightPixels
        val density = metrics.densityDpi

        val mgr = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        mediaProjection = mgr.getMediaProjection(resultCode, resultData)

        imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        virtualDisplay = mediaProjection?.createVirtualDisplay(
            "MiladyCapture",
            width, height, density,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            imageReader?.surface,
            null, null
        )

        val intervalMs = (1000.0 / maxOf(1, fps)).toLong()
        scheduler = Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "milady-capture").also { it.isDaemon = true }
        }
        captureTask = scheduler?.scheduleWithFixedDelay(
            { readLatestFrame() },
            0L, intervalMs, TimeUnit.MILLISECONDS
        )
        isRunning = true
    }

    private fun readLatestFrame() {
        val reader = imageReader ?: return
        val image = reader.acquireLatestImage() ?: return
        try {
            val planes = image.planes
            val buffer = planes[0].buffer
            val pixelStride = planes[0].pixelStride
            val rowStride = planes[0].rowStride
            val width = image.width
            val height = image.height

            val rowPadding = rowStride - pixelStride * width
            val bmp = Bitmap.createBitmap(
                width + rowPadding / pixelStride,
                height,
                Bitmap.Config.ARGB_8888
            )
            bmp.copyPixelsFromBuffer(buffer)
            val croppedBmp = Bitmap.createBitmap(bmp, 0, 0, width, height)
            bmp.recycle()

            val out = ByteArrayOutputStream()
            croppedBmp.compress(Bitmap.CompressFormat.JPEG, 75, out)
            croppedBmp.recycle()

            latestFrame = CapturedFrame(
                jpegBase64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP),
                width = width,
                height = height,
                timestampMs = System.currentTimeMillis(),
            )
        } finally {
            image.close()
        }
    }

    private fun stopCapture() {
        isRunning = false
        latestFrame = null
        captureTask?.cancel(false)
        captureTask = null
        scheduler?.shutdown()
        scheduler = null
        virtualDisplay?.release()
        virtualDisplay = null
        imageReader?.close()
        imageReader = null
        mediaProjection?.stop()
        mediaProjection = null
    }

    // ── Notification (required for foreground service) ────────────────────────

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Screen Capture",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Milady screen capture — required for computer-use"
            }
            (getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
                .createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setContentTitle("Milady Screen Capture")
            .setContentText("Screen is being captured by Milady")
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .build()
    }
}
