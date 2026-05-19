// TODO: validate on device — checklist in ANDROID_CONSTRAINTS.md
//
// Camera2Source — MobileCameraSource implementation via Camera2 API.
//
// Implements the contract defined at:
//   eliza/plugins/plugin-vision/src/mobile/capacitor-camera.ts
//
// Requires CAMERA runtime permission — request via ActivityCompat before
// calling open(). Service-friendly: uses ImageReader surface only, no
// SurfaceView / TextureView needed.
//
// MARK: - Contract (mirrors android-bridge.ts startCamera / stopCamera / captureFrame)
//
// listCameras() → [{ id, label, position }]
// open({ cameraId?, width?, height?, fps? }) → void (throws on permission denied)
// captureJpeg() → base64 JPEG string
// close() → void

package ai.elizaos.computeruse

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.hardware.camera2.CameraAccessException
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.util.Base64
import android.util.Size
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class Camera2Source(private val context: Context) {

    data class CameraEntry(
        val id: String,
        val label: String,
        val position: String, // "back" | "front" | "external"
    )

    private var cameraDevice: CameraDevice? = null
    private var captureSession: CameraCaptureSession? = null
    private var imageReader: ImageReader? = null
    private var backgroundHandler: Handler? = null
    private var backgroundThread: HandlerThread? = null

    // ── Camera enumeration ────────────────────────────────────────────────────

    fun listCameras(): String {
        val mgr = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val arr = JSONArray()
        for (id in mgr.cameraIdList) {
            val chars = mgr.getCameraCharacteristics(id)
            val facing = chars.get(CameraCharacteristics.LENS_FACING)
            val position = when (facing) {
                CameraCharacteristics.LENS_FACING_BACK -> "back"
                CameraCharacteristics.LENS_FACING_FRONT -> "front"
                else -> "external"
            }
            arr.put(JSONObject().apply {
                put("id", id)
                put("label", "$position camera (id=$id)")
                put("position", position)
            })
        }
        return arr.toString()
    }

    // ── Open session ──────────────────────────────────────────────────────────

    @SuppressLint("MissingPermission")
    fun open(
        cameraId: String? = null,
        width: Int = 640,
        height: Int = 480,
        fps: Int = 1,
    ) {
        if (ContextCompat.checkSelfPermission(context, android.Manifest.permission.CAMERA)
            != PackageManager.PERMISSION_GRANTED
        ) {
            throw SecurityException("CAMERA permission not granted")
        }

        startBackgroundThread()
        val mgr = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager

        // Prefer the back camera if no id specified.
        val resolvedId = cameraId ?: mgr.cameraIdList.firstOrNull { id ->
            mgr.getCameraCharacteristics(id)
                .get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK
        } ?: mgr.cameraIdList.first()

        // Clamp to a size the camera actually supports.
        val chars = mgr.getCameraCharacteristics(resolvedId)
        val streamMap = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
        val supportedSizes: Array<Size> = streamMap?.getOutputSizes(ImageFormat.JPEG)
            ?: arrayOf(Size(width, height))
        val size = selectSize(supportedSizes, width, height)

        imageReader = ImageReader.newInstance(size.width, size.height, ImageFormat.JPEG, 2)

        val latch = CountDownLatch(1)
        val errorRef = AtomicReference<Exception>()

        mgr.openCamera(resolvedId, object : CameraDevice.StateCallback() {
            override fun onOpened(camera: CameraDevice) {
                cameraDevice = camera
                openCaptureSession(camera, latch)
            }
            override fun onDisconnected(camera: CameraDevice) {
                camera.close()
                errorRef.set(CameraAccessException(CameraAccessException.CAMERA_DISCONNECTED))
                latch.countDown()
            }
            override fun onError(camera: CameraDevice, error: Int) {
                camera.close()
                errorRef.set(CameraAccessException(error))
                latch.countDown()
            }
        }, backgroundHandler)

        if (!latch.await(5, TimeUnit.SECONDS)) {
            throw CameraAccessException(CameraAccessException.CAMERA_ERROR, "open() timed out")
        }
        errorRef.get()?.let { throw it }
    }

    private fun openCaptureSession(camera: CameraDevice, latch: CountDownLatch) {
        val reader = imageReader ?: return
        val surfaces = listOf(reader.surface)

        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
            val configs = surfaces.map {
                android.hardware.camera2.params.OutputConfiguration(it)
            }
            val sessionConfig = android.hardware.camera2.params.SessionConfiguration(
                android.hardware.camera2.params.SessionConfiguration.SESSION_REGULAR,
                configs,
                { r -> backgroundHandler?.post(r) },
                object : CameraCaptureSession.StateCallback() {
                    override fun onConfigured(session: CameraCaptureSession) {
                        captureSession = session
                        latch.countDown()
                    }
                    override fun onConfigureFailed(session: CameraCaptureSession) {
                        latch.countDown()
                    }
                }
            )
            camera.createCaptureSession(sessionConfig)
        } else {
            @Suppress("DEPRECATION")
            camera.createCaptureSession(surfaces, object : CameraCaptureSession.StateCallback() {
                override fun onConfigured(session: CameraCaptureSession) {
                    captureSession = session
                    latch.countDown()
                }
                override fun onConfigureFailed(session: CameraCaptureSession) {
                    latch.countDown()
                }
            }, backgroundHandler)
        }
    }

    // ── Capture ───────────────────────────────────────────────────────────────

    /**
     * Capture a single JPEG frame and return it as a Base64 string.
     * Blocks the calling thread (Capacitor dispatches on a background executor).
     */
    fun captureJpegBase64(): String {
        val session = captureSession ?: throw IllegalStateException("Camera not open")
        val reader = imageReader ?: throw IllegalStateException("ImageReader not ready")

        val latch = CountDownLatch(1)
        val resultRef = AtomicReference<String>()

        reader.setOnImageAvailableListener({ r ->
            val image = r.acquireLatestImage() ?: return@setOnImageAvailableListener
            try {
                val buf = image.planes[0].buffer
                val bytes = ByteArray(buf.remaining())
                buf.get(bytes)
                resultRef.set(Base64.encodeToString(bytes, Base64.NO_WRAP))
            } finally {
                image.close()
                latch.countDown()
            }
        }, backgroundHandler)

        val captureBuilder = cameraDevice!!.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE)
        captureBuilder.addTarget(reader.surface)
        session.capture(captureBuilder.build(), null, backgroundHandler)

        if (!latch.await(5, TimeUnit.SECONDS)) {
            throw RuntimeException("captureJpeg() timed out")
        }
        return resultRef.get() ?: throw RuntimeException("captureJpeg() produced no image")
    }

    // ── Close ─────────────────────────────────────────────────────────────────

    fun close() {
        captureSession?.close()
        captureSession = null
        cameraDevice?.close()
        cameraDevice = null
        imageReader?.close()
        imageReader = null
        stopBackgroundThread()
    }

    // ── Background thread ─────────────────────────────────────────────────────

    private fun startBackgroundThread() {
        backgroundThread = HandlerThread("milady-camera").also { it.start() }
        backgroundHandler = Handler(backgroundThread!!.looper)
    }

    private fun stopBackgroundThread() {
        backgroundThread?.quitSafely()
        backgroundThread?.join()
        backgroundThread = null
        backgroundHandler = null
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /** Pick the supported size closest to the requested dimensions without exceeding them. */
    private fun selectSize(sizes: Array<Size>, targetW: Int, targetH: Int): Size {
        return sizes
            .filter { it.width <= targetW && it.height <= targetH }
            .maxByOrNull { it.width.toLong() * it.height }
            ?: sizes.minByOrNull { Math.abs(it.width - targetW) + Math.abs(it.height - targetH) }
            ?: Size(targetW, targetH)
    }
}
