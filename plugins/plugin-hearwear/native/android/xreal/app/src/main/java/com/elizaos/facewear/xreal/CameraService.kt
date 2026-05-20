package com.elizaos.facewear.xreal

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
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
import android.webkit.WebView
import androidx.core.content.ContextCompat
import java.io.ByteArrayOutputStream
import java.util.Base64
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix

/**
 * Camera2 API bridge for XReal glasses.
 *
 * Captures JPEG frames from the world-facing camera and forwards them to the
 * elizaOS agent WebSocket via the JavaScript bridge.
 *
 * To replace with the XREAL SDK NRCameraRig: swap the CameraManager/CameraDevice
 * calls below for NRRgbCamera (or NRCameraRig.GetRGBCamera()) from the NRSDK.
 * The JPEG encoding and JS dispatch contract remain identical.
 */
class CameraService(
    private val context: Context,
    private val webView: WebView,
) {
    private val TAG = "FacewearCameraService"

    private var cameraDevice: CameraDevice? = null
    private var captureSession: CameraCaptureSession? = null
    private var imageReader: ImageReader? = null
    private val backgroundThread = HandlerThread("CameraBackground").also { it.start() }
    private val backgroundHandler = Handler(backgroundThread.looper)

    // Frame throttle: target ~4 fps to keep bandwidth reasonable over WebSocket
    private val frameIntervalMs = 250L
    private var lastFrameMs = 0L

    fun start() {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA)
            != PackageManager.PERMISSION_GRANTED
        ) return

        val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val cameraId = selectBackCamera(manager) ?: return

        imageReader = ImageReader.newInstance(640, 480, ImageFormat.JPEG, 2)
        imageReader!!.setOnImageAvailableListener({ reader ->
            val now = System.currentTimeMillis()
            if (now - lastFrameMs < frameIntervalMs) {
                reader.acquireLatestImage()?.close()
                return@setOnImageAvailableListener
            }
            lastFrameMs = now

            val image = reader.acquireLatestImage() ?: return@setOnImageAvailableListener
            try {
                val buffer = image.planes[0].buffer
                val bytes = ByteArray(buffer.remaining())
                buffer.get(bytes)
                dispatchFrame(bytes, now)
            } finally {
                image.close()
            }
        }, backgroundHandler)

        try {
            manager.openCamera(cameraId, cameraStateCallback, backgroundHandler)
        } catch (e: CameraAccessException) {
            android.util.Log.e(TAG, "Failed to open camera: ${e.message}")
        }
    }

    private fun selectBackCamera(manager: CameraManager): String? {
        for (id in manager.cameraIdList) {
            val chars = manager.getCameraCharacteristics(id)
            val facing = chars.get(CameraCharacteristics.LENS_FACING)
            if (facing == CameraCharacteristics.LENS_FACING_BACK) return id
        }
        return manager.cameraIdList.firstOrNull()
    }

    private val cameraStateCallback = object : CameraDevice.StateCallback() {
        override fun onOpened(camera: CameraDevice) {
            cameraDevice = camera
            val surfaces = listOf(imageReader!!.surface)
            camera.createCaptureSession(
                surfaces,
                object : CameraCaptureSession.StateCallback() {
                    override fun onConfigured(session: CameraCaptureSession) {
                        captureSession = session
                        val request = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW)
                        request.addTarget(imageReader!!.surface)
                        session.setRepeatingRequest(request.build(), null, backgroundHandler)
                    }
                    override fun onConfigureFailed(session: CameraCaptureSession) {
                        android.util.Log.e(TAG, "Capture session configuration failed")
                    }
                },
                backgroundHandler
            )
        }

        override fun onDisconnected(camera: CameraDevice) {
            camera.close()
            cameraDevice = null
        }

        override fun onError(camera: CameraDevice, error: Int) {
            android.util.Log.e(TAG, "Camera device error: $error")
            camera.close()
            cameraDevice = null
        }
    }

    private fun dispatchFrame(jpegBytes: ByteArray, ts: Long) {
        // Build the binary frame header matching the elizaOS XR binary protocol:
        //   4 bytes big-endian uint32 = JSON header length
        //   JSON header bytes
        //   raw JPEG payload
        val header = """{"type":"frame","ts":$ts,"width":640,"height":480,"format":"jpeg"}"""
        val headerBytes = header.toByteArray(Charsets.UTF_8)
        val lenBytes = ByteArray(4)
        lenBytes[0] = (headerBytes.size shr 24).toByte()
        lenBytes[1] = (headerBytes.size shr 16).toByte()
        lenBytes[2] = (headerBytes.size shr 8).toByte()
        lenBytes[3] = (headerBytes.size).toByte()
        val frame = lenBytes + headerBytes + jpegBytes
        val b64 = Base64.getEncoder().encodeToString(frame)
        // Send via JS bridge — ElizaXreal.sendBinaryFrame(base64String)
        webView.post {
            webView.evaluateJavascript(
                "window.__elizaXrealBridge && window.__elizaXrealBridge.onCameraFrame('$b64');",
                null
            )
        }
    }

    fun stop() {
        captureSession?.close()
        captureSession = null
        cameraDevice?.close()
        cameraDevice = null
        imageReader?.close()
        imageReader = null
        backgroundThread.quitSafely()
    }
}
