package ai.eliza.plugins.camera

import android.Manifest
import android.annotation.SuppressLint
import android.hardware.camera2.CameraCharacteristics
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import android.hardware.camera2.CaptureResult
import androidx.camera.core.CameraInfo
import androidx.camera.core.impl.CameraInfoInternal
import androidx.camera.core.impl.CameraCaptureCallback
import androidx.camera.core.impl.CameraCaptureResult
import androidx.core.content.ContextCompat
import java.util.concurrent.atomic.AtomicReference
import android.os.Bundle
import android.os.Build
import android.os.SystemClock
import android.util.Base64
import androidx.camera.core.CameraSelector
import androidx.camera.core.CameraState
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.SurfaceOrientedMeteringPointFactory
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Actual WebView promises and CameraX state; no replacement camera control. */
@SuppressLint("RestrictedApi") // Test-only observer of the pinned CameraX capture session.
@RunWith(AndroidJUnit4::class)
class CameraControlsInstrumentedTest {
    @get:Rule val cameraPermission = GrantPermissionRule.grant(Manifest.permission.CAMERA)

    private class CaptureProbe(info: CameraInfo) : AutoCloseable {
        private val info = info as CameraInfoInternal
        val latest = AtomicReference<CaptureResult?>()
        val frames = AtomicInteger()
        private val callback = object : CameraCaptureCallback() {
            override fun onCaptureCompleted(captureConfigId: Int, result: CameraCaptureResult) {
                result.captureResult?.let { latest.set(it); frames.incrementAndGet() }
            }
        }
        init {
            val instrumentation = InstrumentationRegistry.getInstrumentation()
            instrumentation.runOnMainSync {
                this.info.addSessionCaptureCallback(ContextCompat.getMainExecutor(instrumentation.targetContext), callback)
            }
        }
        override fun close() {
            InstrumentationRegistry.getInstrumentation().runOnMainSync { info.removeSessionCaptureCallback(callback) }
        }
    }

    private fun evaluate(scenario: ActivityScenario<CameraTestActivity>, script: String): String {
        val latch = CountDownLatch(1)
        var value = "null"
        scenario.onActivity { it.bridge.webView.evaluateJavascript(script) { result -> value = result; latch.countDown() } }
        assertTrue("WebView evaluation timed out", latch.await(5, TimeUnit.SECONDS))
        return value
    }
    private fun awaitState(message: String, predicate: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 15000
        while (!predicate()) {
            assertTrue(message, SystemClock.elapsedRealtime() < deadline)
            SystemClock.sleep(30)
        }
    }
    private fun ready(scenario: ActivityScenario<CameraTestActivity>) {
        awaitState("Camera bridge did not load") {
            evaluate(scenario, "document.readyState === 'complete' && Boolean(window.Capacitor?.isPluginAvailable('ElizaCamera'))") == "true"
        }
    }
    private fun call(scenario: ActivityScenario<CameraTestActivity>, method: String, options: String = "{}"): JSONObject {
        evaluate(scenario, """
            window.controlResult = null;
            window.Capacitor.nativePromise('ElizaCamera', '$method', $options).then(
              value => window.controlResult = {ok:true, value},
              error => window.controlResult = {ok:false, error:String(error.message ?? error), code:error.code});
        """.trimIndent())
        awaitState("$method did not settle") { evaluate(scenario, "window.controlResult !== null") == "true" }
        return JSONObject(JSONTokener(evaluate(scenario, "JSON.stringify(window.controlResult)")).nextValue() as String)
    }
    private fun cameraInfo(selector: CameraSelector = CameraSelector.DEFAULT_BACK_CAMERA) = selector.filter(
        ProcessCameraProvider.getInstance(InstrumentationRegistry.getInstrumentation().targetContext).get().availableCameraInfos).first()
    private fun preview(scenario: ActivityScenario<CameraTestActivity>) {
        ready(scenario)
        val result = call(scenario, "startPreview", "{direction:'back',resolution:{width:640,height:480}}")
        assertTrue("Preview failed: $result", result.getBoolean("ok"))
        awaitState("Camera did not open") { cameraInfo().cameraState.value?.type == CameraState.Type.OPEN }
    }
    private fun emit(name: String, receipts: JSONArray) {
        InstrumentationRegistry.getInstrumentation().sendStatus(2, Bundle().apply {
            putString("nativeArtifactName", name)
            putString("nativeArtifactBase64", Base64.encodeToString(receipts.toString().toByteArray(), Base64.NO_WRAP))
        })
    }

    @Test fun zoomRatioAgreesWithCameraX_andInvalidZoomDoesNotChangeSettings() {
        val receipts = JSONArray()
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            preview(scenario)
            try {
                val info = cameraInfo()
                val initial = requireNotNull(info.zoomState.value)
                val target = (initial.minZoomRatio + initial.maxZoomRatio) / 2
                CaptureProbe(info).use { probe ->
                    awaitState("Camera2 did not deliver a completed capture") { probe.latest.get() != null }
                    val baselineCrop = requireNotNull(probe.latest.get()?.get(CaptureResult.SCALER_CROP_REGION))
                    val result = call(scenario, "setZoom", "{zoom:$target}")
                    assertTrue("Zoom request failed: $result", result.getBoolean("ok"))
                    val observed = requireNotNull(info.zoomState.value).zoomRatio
                    receipts.put(JSONObject().put("requestedRatio", target.toDouble()).put("actualRatio", observed.toDouble())
                        .put("minRatio", initial.minZoomRatio.toDouble()).put("maxRatio", initial.maxZoomRatio.toDouble()).put("result", result))
                    assertEquals("A ratio is not CameraX linear zoom", target.toDouble(), observed.toDouble(), 0.01)
                    fun captureRatio(): Double? {
                        val capture = probe.latest.get() ?: return null
                        val ratio = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) capture.get(CaptureResult.CONTROL_ZOOM_RATIO) else null
                        if (ratio != null && ratio != 1f) return ratio.toDouble()
                        val crop = capture.get(CaptureResult.SCALER_CROP_REGION) ?: return null
                        return baselineCrop.width().toDouble() / crop.width()
                    }
                    awaitState("Camera2 capture metadata did not apply requested zoom") {
                        captureRatio()?.let { kotlin.math.abs(it - target) < 0.02 } == true
                    }
                    receipts.put(JSONObject().put("captureRatio", captureRatio()).put("captureFrame", probe.latest.get()?.frameNumber))
                    for (options in listOf("{}", "{zoom:'2'}", "{zoom:-1}", "{zoom:${initial.maxZoomRatio + 1}}")) {
                        val denied = call(scenario, "setZoom", options)
                        receipts.put(JSONObject().put("options", options).put("result", denied))
                        assertFalse("Invalid zoom must reject: $options", denied.getBoolean("ok"))
                        assertEquals(target.toDouble(), requireNotNull(info.zoomState.value).zoomRatio.toDouble(), 0.01)
                        val settings = call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings")
                        assertEquals(target.toDouble(), settings.getDouble("zoom"), 0.01)
                    }
                    val batchRatio = initial.minZoomRatio
                    val batch = call(scenario, "setSettings", "{settings:{zoom:$batchRatio}}")
                    assertTrue("Standalone batch zoom must succeed: $batch", batch.getBoolean("ok"))
                    val count = probe.frames.get()
                    awaitState("Standalone batch zoom must reach completed captures") {
                        probe.frames.get() >= count + 3 && captureRatio()?.let { kotlin.math.abs(it - batchRatio) < 0.02 } == true
                    }
                    val settings = call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings")
                    assertEquals(batchRatio.toDouble(), settings.getDouble("zoom"), 0.001)
                    assertEquals(batchRatio.toDouble(), requireNotNull(info.zoomState.value).zoomRatio.toDouble(), 0.001)
                    receipts.put(JSONObject().put("stage", "standalone-batch").put("requestedRatio", batchRatio.toDouble())
                        .put("captureRatio", captureRatio()).put("reportedRatio", settings.getDouble("zoom")).put("result", batch))
                }
            } finally {
                call(scenario, "stopPreview")
                emit("camera-control-zoom.json", receipts)
            }
        }
    }

    @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
    @Test fun whiteBalancePresetsReachCompletedCamera2Captures() {
        val receipts = JSONArray()
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            preview(scenario)
            try {
                val info = cameraInfo()
                val supported = Camera2CameraInfo.from(info).getCameraCharacteristic(CameraCharacteristics.CONTROL_AWB_AVAILABLE_MODES) ?: intArrayOf()
                val presets = listOf("daylight" to CaptureResult.CONTROL_AWB_MODE_DAYLIGHT,
                    "cloudy" to CaptureResult.CONTROL_AWB_MODE_CLOUDY_DAYLIGHT,
                    "tungsten" to CaptureResult.CONTROL_AWB_MODE_INCANDESCENT,
                    "fluorescent" to CaptureResult.CONTROL_AWB_MODE_FLUORESCENT,
                    "auto" to CaptureResult.CONTROL_AWB_MODE_AUTO)
                CaptureProbe(info).use { probe ->
                    for ((preset, mode) in presets) {
                        val before = call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings").getString("whiteBalance")
                        val result = call(scenario, "setSettings", "{settings:{whiteBalance:'$preset'}}")
                        val receipt = JSONObject().put("preset", preset).put("expectedCamera2Mode", mode)
                            .put("supported", mode in supported).put("result", result)
                        receipts.put(receipt)
                        if (mode in supported) {
                            assertTrue("Supported white balance failed: $result", result.getBoolean("ok"))
                            try {
                                awaitState("White balance $preset must reach completed Camera2 captures") {
                                    probe.latest.get()?.get(CaptureResult.CONTROL_AWB_MODE) == mode
                                }
                            } finally { receipt.put("actualCamera2Mode", probe.latest.get()?.get(CaptureResult.CONTROL_AWB_MODE)) }
                            assertEquals(preset, call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings").getString("whiteBalance"))
                        } else {
                            assertFalse("Unsupported white balance cannot report success", result.getBoolean("ok"))
                            assertEquals("WHITE_BALANCE_UNSUPPORTED", result.getString("code"))
                            assertEquals(before, call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings").getString("whiteBalance"))
                        }
                    }
                }
            } finally {
                call(scenario, "stopPreview")
                emit("camera-white-balance.json", receipts)
            }
        }
    }

    @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
    @Test fun confirmedSettingsSurvivePreviewRestartSwitchAndRecording() {
        val receipts = JSONArray()
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            preview(scenario)
            val back = cameraInfo()
            val front = cameraInfo(CameraSelector.DEFAULT_FRONT_CAMERA)
            fun supports(info: CameraInfo, mode: Int) = mode in (Camera2CameraInfo.from(info)
                .getCameraCharacteristic(CameraCharacteristics.CONTROL_AWB_AVAILABLE_MODES) ?: intArrayOf())
            val mode = listOf(CaptureResult.CONTROL_AWB_MODE_DAYLIGHT, CaptureResult.CONTROL_AWB_MODE_FLUORESCENT,
                CaptureResult.CONTROL_AWB_MODE_AUTO).first { supports(back, it) && supports(front, it) }
            val preset = when(mode) { CaptureResult.CONTROL_AWB_MODE_DAYLIGHT -> "daylight"
                CaptureResult.CONTROL_AWB_MODE_FLUORESCENT -> "fluorescent"; else -> "auto" }
            val maximumEv = minOf(back.exposureState.exposureCompensationRange.upper * back.exposureState.exposureCompensationStep.toDouble(),
                front.exposureState.exposureCompensationRange.upper * front.exposureState.exposureCompensationStep.toDouble())
            val requestedEv = if (back.exposureState.isExposureCompensationSupported && front.exposureState.isExposureCompensationSupported && maximumEv > 0)
                minOf(back.exposureState.exposureCompensationStep.toDouble() * 0.75, maximumEv) else null
            val backZoom = requireNotNull(back.zoomState.value)
            val frontZoom = requireNotNull(front.zoomState.value)
            val requestedZoom = (maxOf(backZoom.minZoomRatio, frontZoom.minZoomRatio) + minOf(backZoom.maxZoomRatio, frontZoom.maxZoomRatio)) / 2
            var requestedFlash = if (back.hasFlashUnit()) "torch" else "off"
            val lockedDistances = mutableMapOf<String, Float>()
            fun observed(probe: CaptureProbe, info: CameraInfo, stage: String) {
                val sensor = requireNotNull(Camera2CameraInfo.from(info).getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE))
                fun captureZoom(): Double? {
                    val result = probe.latest.get() ?: return null
                    val ratio = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) result.get(CaptureResult.CONTROL_ZOOM_RATIO) else null
                    if (ratio != null && ratio != 1f) return ratio.toDouble()
                    val crop = result.get(CaptureResult.SCALER_CROP_REGION) ?: return null
                    return sensor.width().toDouble() / crop.width()
                }
                val step = info.exposureState.exposureCompensationStep.toDouble()
                val count = probe.frames.get()
                awaitState("$stage must retain $preset in new captures") {
                    val exposureIndex = probe.latest.get()?.get(CaptureResult.CONTROL_AE_EXPOSURE_COMPENSATION)
                    probe.frames.get() >= count + 3 && probe.latest.get()?.get(CaptureResult.CONTROL_AF_MODE) == CaptureResult.CONTROL_AF_MODE_OFF &&
                        probe.latest.get()?.get(CaptureResult.FLASH_MODE) == (if(requestedFlash == "torch") CaptureResult.FLASH_MODE_TORCH else CaptureResult.FLASH_MODE_OFF) &&
                        kotlin.math.abs((captureZoom() ?: 0.0) - requestedZoom) < 0.03 &&
                        probe.latest.get()?.get(CaptureResult.CONTROL_AWB_MODE) == mode &&
                        (requestedEv == null || (exposureIndex != null && kotlin.math.abs(exposureIndex * step - requestedEv) <= step / 2 + 0.000001))
                }
                receipts.put(JSONObject().put("stage", stage).put("preset", preset)
                    .put("actualCamera2Mode", probe.latest.get()?.get(CaptureResult.CONTROL_AWB_MODE))
                    .put("newCaptures", probe.frames.get() - count)
                    .put("capturedAfMode", probe.latest.get()?.get(CaptureResult.CONTROL_AF_MODE))
                    .put("capturedFocusDistance", probe.latest.get()?.get(CaptureResult.LENS_FOCUS_DISTANCE))
                    .put("maximumFocusDistance", Camera2CameraInfo.from(info).getCameraCharacteristic(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE))
                    .put("requestedFlash", requestedFlash).put("capturedFlashMode", probe.latest.get()?.get(CaptureResult.FLASH_MODE))
                    .put("requestedZoom", requestedZoom.toDouble()).put("capturedZoom", captureZoom())
                    .put("requestedEv", requestedEv ?: JSONObject.NULL)
                    .put("actualExposureIndex", probe.latest.get()?.get(CaptureResult.CONTROL_AE_EXPOSURE_COMPENSATION)))
                val distance = requireNotNull(probe.latest.get()?.get(CaptureResult.LENS_FOCUS_DISTANCE))
                val cameraId = Camera2CameraInfo.from(info).cameraId
                val locked = lockedDistances.getOrPut(cameraId) { distance }
                assertEquals("Each lens retains its own manual distance", locked.toDouble(), distance.toDouble(), 0.001)
                assertEquals(requestedZoom.toDouble(), requireNotNull(info.zoomState.value).zoomRatio.toDouble(), 0.001)
                assertEquals(requestedZoom.toDouble(), call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings").getDouble("zoom"), 0.001)
                if (requestedEv != null) {
                    val index = requireNotNull(probe.latest.get()?.get(CaptureResult.CONTROL_AE_EXPOSURE_COMPENSATION))
                    assertEquals(index * step, call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings").getDouble("exposureCompensation"), 0.000001)
                }
            }
            try {
                CaptureProbe(back).use { probe ->
                    val options = JSONObject().put("whiteBalance", preset).put("zoom", requestedZoom.toDouble()).put("flash", requestedFlash).put("focusMode", "manual")
                    if (requestedEv != null) options.put("exposureCompensation", requestedEv)
                    assertTrue(call(scenario, "setSettings", JSONObject().put("settings", options).toString()).getBoolean("ok"))
                    observed(probe, back, "selected")
                    assertTrue(call(scenario, "stopPreview").getBoolean("ok"))
                    preview(scenario)
                    observed(probe, back, "restarted")
                    assertTrue(call(scenario, "startRecording", "{audio:false,quality:'low'}").getBoolean("ok"))
                    try {
                        observed(probe, back, "recording")
                        var recorded = JSONObject()
                        awaitState("Recording must contain encoded media before stopping") {
                            recorded = call(scenario, "getRecordingState").getJSONObject("value")
                            recorded.getBoolean("isRecording") && recorded.getLong("fileSize") > 0 && recorded.getDouble("duration") > 0
                        }
                        receipts.put(JSONObject().put("stage", "encoded-video").put("state", recorded))
                    }
                    finally {
                        val stopped = call(scenario, "stopRecording")
                        assertTrue("Recording must finalize: $stopped", stopped.getBoolean("ok"))
                        val file = java.io.File(requireNotNull(android.net.Uri.parse(stopped.getJSONObject("value").getString("path")).path))
                        val cache = InstrumentationRegistry.getInstrumentation().targetContext.cacheDir.canonicalFile
                        assertEquals("Only delete this test's generated cache video", cache, file.canonicalFile.parentFile)
                        assertTrue(file.delete())
                    }
                }
                if (requestedFlash == "torch" && !front.hasFlashUnit()) {
                    val rejected = call(scenario, "switchCamera", "{direction:'front'}")
                    receipts.put(JSONObject().put("stage", "unsupported-flash-switch").put("result", rejected))
                    assertFalse("Switch cannot discard confirmed torch", rejected.getBoolean("ok"))
                    assertEquals(CameraState.Type.OPEN, back.cameraState.value?.type)
                    assertEquals(1, back.torchState.value)
                }
                if (!front.hasFlashUnit()) {
                    requestedFlash = "off"
                    assertTrue(call(scenario, "setSettings", "{settings:{flash:'off'}}").getBoolean("ok"))
                }
                CaptureProbe(front).use { probe ->
                    assertTrue(call(scenario, "switchCamera", "{direction:'front'}").getBoolean("ok"))
                    observed(probe, front, "front")
                }
                CaptureProbe(back).use { probe ->
                    assertTrue(call(scenario, "switchCamera", "{direction:'back'}").getBoolean("ok"))
                    observed(probe, back, "back")
                }
            } finally {
                call(scenario, "stopPreview")
                emit("camera-confirmed-settings-lifecycle.json", receipts)
            }
        }
    }

    @Test fun recordingCancelledDuringSettingsRestorationSettlesBothCalls() {
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            preview(scenario)
            val settled = CountDownLatch(3)
            val replies = JSONArray()
            fun pending(method: String, data: JSObject) = object : PluginCall(null, "ElizaCamera", method, method, data) {
                override fun resolve() { replies.put(JSONObject().put("method", method).put("resolved", true)); settled.countDown() }
                override fun resolve(value: JSObject?) { resolve() }
                override fun reject(message: String?, code: String?, error: Exception?, data: JSObject?) {
                    replies.put(JSONObject().put("method", method).put("resolved", false).put("code", code)); settled.countDown()
                }
            }
            try {
                scenario.onActivity { activity ->
                    val plugin = activity.bridge.getPlugin("ElizaCamera").instance as CameraPlugin
                    plugin.startRecording(pending("startRecording", JSObject().put("audio", false).put("quality", "low")))
                    plugin.setSettings(pending("setSettings", JSObject().put("settings", JSObject().put("exposureCompensation", 1))))
                    plugin.stopRecording(pending("stopRecording", JSObject()))
                }
                assertTrue("Both pending recording calls must settle", settled.await(10, TimeUnit.SECONDS))
                assertEquals(3, replies.length())
                for (index in 0 until replies.length()) {
                    assertFalse("No recording can succeed before native settings complete", replies.getJSONObject(index).getBoolean("resolved"))
                    val reply = replies.getJSONObject(index)
                    assertEquals(if (reply.getString("method") == "setSettings") "CAMERA_NOT_READY" else "RECORDING_ERROR", reply.getString("code"))
                }
                assertFalse(call(scenario, "getRecordingState").getJSONObject("value").getBoolean("isRecording"))
            } finally {
                call(scenario, "stopPreview")
                emit("camera-white-balance-recording-cancel.json", replies)
            }
        }
    }

    @Test fun stoppingPreviewRejectsActiveAndQueuedCameraSwitches() {
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            preview(scenario)
            val settled = CountDownLatch(3)
            val replies = JSONArray()
            fun pending(name: String, method: String) = object : PluginCall(null, "ElizaCamera", name, method, JSObject()) {
                override fun resolve() { replies.put(JSONObject().put("call", name).put("resolved", true)); settled.countDown() }
                override fun resolve(value: JSObject?) { resolve() }
                override fun reject(message: String?, code: String?, error: Exception?, data: JSObject?) {
                    replies.put(JSONObject().put("call", name).put("resolved", false).put("code", code)); settled.countDown()
                }
            }
            try {
                scenario.onActivity { activity ->
                    val plugin = activity.bridge.getPlugin("ElizaCamera").instance as CameraPlugin
                    plugin.switchCamera(pending("first", "switchCamera"))
                    plugin.switchCamera(pending("queued", "switchCamera"))
                    plugin.stopPreview(pending("stop", "stopPreview"))
                }
                assertTrue("Active and queued switches must settle on stop", settled.await(10, TimeUnit.SECONDS))
                assertEquals(3, replies.length())
                for (index in 0 until replies.length()) {
                    val reply = replies.getJSONObject(index)
                    assertEquals(reply.getString("call") == "stop", reply.getBoolean("resolved"))
                }
                // A fresh preview must work after cancellation releases the queue.
                preview(scenario)
            } finally {
                call(scenario, "stopPreview")
                emit("camera-white-balance-switch-cancel.json", replies)
            }
        }
    }

    @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
    @Test fun settingsZoomRejectsUnsupportedRatioBeforeBatchMutation() {
        val receipts = JSONArray()
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            preview(scenario)
            try {
                val info = cameraInfo()
                val bounds = requireNotNull(info.zoomState.value)
                val before = call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings")
                CaptureProbe(info).use { probe ->
                    awaitState("Need native capture before rejected zoom") { probe.latest.get() != null }
                    val baseline = probe.latest.get()?.get(CaptureResult.CONTROL_AWB_MODE)
                    val modes = Camera2CameraInfo.from(info).getCameraCharacteristic(CameraCharacteristics.CONTROL_AWB_AVAILABLE_MODES) ?: intArrayOf()
                    val preset = if (CaptureResult.CONTROL_AWB_MODE_DAYLIGHT in modes) "daylight" else "auto"
                    val result = call(scenario, "setSettings", "{settings:{zoom:${bounds.maxZoomRatio + 1},whiteBalance:'$preset'}}")
                    val after = call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings")
                    receipts.put(JSONObject().put("requestedRatio", (bounds.maxZoomRatio + 1).toDouble())
                        .put("maximumRatio", bounds.maxZoomRatio.toDouble()).put("whiteBalance", preset).put("result", result)
                        .put("before", before).put("after", after)
                        .put("actualRatio", requireNotNull(info.zoomState.value).zoomRatio.toDouble()))
                    assertFalse("Unsupported batch zoom cannot report success", result.getBoolean("ok"))
                    assertEquals("ZOOM_OUT_OF_RANGE", result.getString("code"))
                    assertEquals(before.toString(), after.toString())
                    val count = probe.frames.get()
                    awaitState("Need fresh captures after rejection") { probe.frames.get() >= count + 3 }
                    assertEquals(baseline, probe.latest.get()?.get(CaptureResult.CONTROL_AWB_MODE))
                    assertEquals(bounds.zoomRatio.toDouble(), requireNotNull(info.zoomState.value).zoomRatio.toDouble(), 0.001)
                }
            } finally {
                call(scenario, "stopPreview")
                emit("camera-settings-zoom-range.json", receipts)
            }
        }
    }

    @Test fun flashPoliciesReachNativeCaptures_andUnsupportedCamerasRejectMixedBatch() {
        val receipts = JSONArray()
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            preview(scenario)
            try {
                for ((direction, selector) in listOf("back" to CameraSelector.DEFAULT_BACK_CAMERA, "front" to CameraSelector.DEFAULT_FRONT_CAMERA)) {
                    if (direction == "front") assertTrue(call(scenario, "switchCamera", "{direction:'front'}").getBoolean("ok"))
                    val info = cameraInfo(selector)
                    CaptureProbe(info).use { probe ->
                        for (mode in listOf("torch", "on", "auto", "off")) {
                            val before = call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings")
                            val zoom = requireNotNull(info.zoomState.value)
                            val targetZoom = (zoom.minZoomRatio + zoom.maxZoomRatio) / 2
                            val result = call(scenario, "setSettings", "{settings:{flash:'$mode',zoom:$targetZoom}}")
                            val receipt = JSONObject().put("direction", direction).put("mode", mode)
                                .put("hasFlash", info.hasFlashUnit()).put("result", result)
                            receipts.put(receipt)
                            if (!info.hasFlashUnit() && mode != "off") {
                                assertFalse("Unsupported flash cannot succeed", result.getBoolean("ok"))
                                assertEquals("FLASH_UNSUPPORTED", result.getString("code"))
                                val after = call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings")
                                assertEquals(before.toString(), after.toString())
                                assertEquals(zoom.zoomRatio.toDouble(), requireNotNull(info.zoomState.value).zoomRatio.toDouble(), 0.001)
                                continue
                            }
                            assertTrue("Flash mode $mode failed: $result", result.getBoolean("ok"))
                            val expectedFlash = if (mode == "torch") CaptureResult.FLASH_MODE_TORCH else CaptureResult.FLASH_MODE_OFF
                            val expectedAe = when(mode) { "auto" -> CaptureResult.CONTROL_AE_MODE_ON_AUTO_FLASH
                                "on" -> CaptureResult.CONTROL_AE_MODE_ON_ALWAYS_FLASH; else -> CaptureResult.CONTROL_AE_MODE_ON }
                            val count = probe.frames.get()
                            try {
                                awaitState("Flash $mode must reach completed captures") {
                                    probe.frames.get() >= count + 3 && probe.latest.get()?.get(CaptureResult.FLASH_MODE) == expectedFlash &&
                                        probe.latest.get()?.get(CaptureResult.CONTROL_AE_MODE) == expectedAe
                                }
                            } finally {
                                receipt.put("capturedFlashMode", probe.latest.get()?.get(CaptureResult.FLASH_MODE))
                                    .put("capturedAeMode", probe.latest.get()?.get(CaptureResult.CONTROL_AE_MODE))
                                    .put("torchState", info.torchState.value)
                            }
                            assertEquals(if(mode == "torch") 1 else 0, info.torchState.value)
                            assertEquals(mode, call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings").getString("flash"))
                        }
                    }
                }
            } finally {
                call(scenario, "setSettings", "{settings:{flash:'off'}}")
                call(scenario, "stopPreview")
                emit("camera-flash-policies.json", receipts)
            }
        }
    }

    @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
    @Test fun focusModesReachCompletedCaptures_andManualRetainsObservedDistance() {
        val receipts = JSONArray()
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            preview(scenario)
            val info = cameraInfo()
            val modes = Camera2CameraInfo.from(info).getCameraCharacteristic(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES) ?: intArrayOf()
            try {
                CaptureProbe(info).use { probe ->
                    awaitState("Need native focus metadata") { probe.latest.get() != null }
                    for ((preset, mode) in listOf("manual" to CaptureResult.CONTROL_AF_MODE_OFF,
                        "auto" to CaptureResult.CONTROL_AF_MODE_AUTO, "continuous" to CaptureResult.CONTROL_AF_MODE_CONTINUOUS_PICTURE)) {
                        val beforeDistance = probe.latest.get()?.get(CaptureResult.LENS_FOCUS_DISTANCE)
                        val result = call(scenario, "setSettings", "{settings:{focusMode:'$preset'}}")
                        val receipt = JSONObject().put("preset", preset).put("expectedAfMode", mode)
                            .put("supported", mode in modes).put("beforeDistance", beforeDistance).put("result", result)
                        receipts.put(receipt)
                        if (mode !in modes) {
                            assertFalse("Unsupported focus mode must reject", result.getBoolean("ok"))
                            assertEquals("FOCUS_UNSUPPORTED", result.getString("code"))
                            continue
                        }
                        assertTrue("Focus mode $preset failed: $result", result.getBoolean("ok"))
                        val count = probe.frames.get()
                        try {
                            awaitState("$preset must change completed native AF mode") {
                                probe.frames.get() >= count + 3 && probe.latest.get()?.get(CaptureResult.CONTROL_AF_MODE) == mode
                            }
                        } finally {
                            receipt.put("capturedAfMode", probe.latest.get()?.get(CaptureResult.CONTROL_AF_MODE))
                                .put("capturedDistance", probe.latest.get()?.get(CaptureResult.LENS_FOCUS_DISTANCE))
                                .put("capturedAfState", probe.latest.get()?.get(CaptureResult.CONTROL_AF_STATE))
                        }
                        if (preset == "auto") {
                            assertTrue("Auto mode must trigger a completed autofocus attempt", probe.latest.get()?.get(CaptureResult.CONTROL_AF_STATE) in
                                setOf(CaptureResult.CONTROL_AF_STATE_FOCUSED_LOCKED, CaptureResult.CONTROL_AF_STATE_NOT_FOCUSED_LOCKED))
                            assertTrue(call(scenario, "stopPreview").getBoolean("ok"))
                            preview(scenario)
                            val restartedCount = probe.frames.get()
                            awaitState("Auto focus must be restored and triggered after restart") {
                                probe.frames.get() >= restartedCount + 3 && probe.latest.get()?.get(CaptureResult.CONTROL_AF_MODE) == mode &&
                                    probe.latest.get()?.get(CaptureResult.CONTROL_AF_STATE) in setOf(CaptureResult.CONTROL_AF_STATE_FOCUSED_LOCKED, CaptureResult.CONTROL_AF_STATE_NOT_FOCUSED_LOCKED)
                            }
                            receipt.put("restartAfMode", probe.latest.get()?.get(CaptureResult.CONTROL_AF_MODE))
                                .put("restartAfState", probe.latest.get()?.get(CaptureResult.CONTROL_AF_STATE))
                        }
                        if (preset == "continuous") {
                            assertTrue("Continuous focus must release the prior single-shot lock", probe.latest.get()?.get(CaptureResult.CONTROL_AF_STATE) in
                                setOf(CaptureResult.CONTROL_AF_STATE_INACTIVE, CaptureResult.CONTROL_AF_STATE_PASSIVE_SCAN,
                                    CaptureResult.CONTROL_AF_STATE_PASSIVE_FOCUSED, CaptureResult.CONTROL_AF_STATE_PASSIVE_UNFOCUSED))
                        }
                        if (preset == "manual" && beforeDistance != null) {
                            assertEquals(beforeDistance.toDouble(), requireNotNull(probe.latest.get()?.get(CaptureResult.LENS_FOCUS_DISTANCE)).toDouble(), 0.001)
                        }
                        assertEquals(preset, call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings").getString("focusMode"))
                    }
                }
            } finally {
                call(scenario, "stopPreview")
                emit("camera-focus-modes.json", receipts)
            }
        }
    }

    @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
    @Test fun unsupportedFocusPolicyRejectsBeforeMixedBatchChangesZoom() {
        val receipts = JSONArray()
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            preview(scenario)
            try {
                assertTrue(call(scenario, "switchCamera", "{direction:'front'}").getBoolean("ok"))
                val info = cameraInfo(CameraSelector.DEFAULT_FRONT_CAMERA)
                val modes = Camera2CameraInfo.from(info).getCameraCharacteristic(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES) ?: intArrayOf()
                val unsupported = listOf("continuous" to CaptureResult.CONTROL_AF_MODE_CONTINUOUS_PICTURE,
                    "auto" to CaptureResult.CONTROL_AF_MODE_AUTO).firstOrNull { it.second !in modes }
                receipts.put(JSONObject().put("availableAfModes", JSONArray(modes.toList())).put("unsupportedPreset", unsupported?.first ?: JSONObject.NULL))
                if (unsupported != null) {
                    val before = call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings")
                    val bounds = requireNotNull(info.zoomState.value)
                    val ratio = (bounds.minZoomRatio + bounds.maxZoomRatio) / 2
                    val result = call(scenario, "setSettings", "{settings:{focusMode:'${unsupported.first}',zoom:$ratio}}")
                    val after = call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings")
                    receipts.put(JSONObject().put("result", result).put("before", before).put("after", after)
                        .put("nativeZoom", requireNotNull(info.zoomState.value).zoomRatio.toDouble()))
                    assertFalse(result.getBoolean("ok"))
                    assertEquals("FOCUS_UNSUPPORTED", result.getString("code"))
                    assertEquals(before.toString(), after.toString())
                    assertEquals(bounds.zoomRatio.toDouble(), requireNotNull(info.zoomState.value).zoomRatio.toDouble(), 0.001)
                }
            } finally {
                call(scenario, "stopPreview")
                emit("camera-focus-unsupported.json", receipts)
            }
        }
    }

    @Test fun focusPointLeavesManualLockAndTriggersNativeAutofocus() {
        val receipts = JSONArray()
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            preview(scenario)
            try {
                CaptureProbe(cameraInfo()).use { probe ->
                    awaitState("Need lens distance before locking") { probe.latest.get()?.get(CaptureResult.LENS_FOCUS_DISTANCE) != null }
                    assertTrue(call(scenario, "setSettings", "{settings:{focusMode:'manual'}}").getBoolean("ok"))
                    val result = call(scenario, "setFocusPoint", "{x:0.5,y:0.5}")
                    assertTrue("Focus point must leave manual lock: $result", result.getBoolean("ok"))
                    awaitState("Point focus must use native auto mode") {
                        probe.latest.get()?.get(CaptureResult.CONTROL_AF_MODE) == CaptureResult.CONTROL_AF_MODE_AUTO
                    }
                    val settings = call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings")
                    receipts.put(JSONObject().put("result", result).put("settings", settings)
                        .put("afMode", probe.latest.get()?.get(CaptureResult.CONTROL_AF_MODE))
                        .put("afState", probe.latest.get()?.get(CaptureResult.CONTROL_AF_STATE)))
                    assertEquals("auto", settings.getString("focusMode"))
                }
            } finally {
                call(scenario, "stopPreview")
                emit("camera-focus-point-policy.json", receipts)
            }
        }
    }

    @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
    @Test fun manualExposureReachesSensorAndSurvivesFocusAndRestart() {
        val receipts = JSONArray()
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            preview(scenario)
            val info = cameraInfo()
            val details = Camera2CameraInfo.from(info)
            val capabilities = details.getCameraCharacteristic(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES) ?: intArrayOf()
            try {
                CaptureProbe(info).use { probe ->
                    awaitState("Need completed sensor metadata") { probe.latest.get()?.get(CaptureResult.SENSOR_SENSITIVITY) != null }
                    if (CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR !in capabilities) {
                        val result = call(scenario, "setSettings", "{settings:{exposureMode:'manual'}}")
                        receipts.put(JSONObject().put("manualSensorSupported", false).put("result", result))
                        assertFalse("Unsupported manual exposure must reject", result.getBoolean("ok"))
                        assertEquals("EXPOSURE_UNSUPPORTED", result.getString("code"))
                    } else {
                        val isoRange = requireNotNull(details.getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE))
                        val timeRange = requireNotNull(details.getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE))
                        var iso = (isoRange.lower + (isoRange.upper - isoRange.lower) / 4)
                        var nanos = 10_000_000L.coerceIn(timeRange.lower, timeRange.upper)
                        fun inspect(stage: String, captureProbe: CaptureProbe = probe) {
                            val count = captureProbe.frames.get()
                            val receipt = JSONObject().put("stage", stage).put("requestedIso", iso).put("requestedNanos", nanos)
                            receipts.put(receipt)
                            try {
                                awaitState("Manual exposure must reach completed sensor captures at $stage") {
                                    val result = captureProbe.latest.get()
                                    captureProbe.frames.get() >= count + 3 && result?.get(CaptureResult.CONTROL_AE_MODE) == CaptureResult.CONTROL_AE_MODE_OFF &&
                                        result.get(CaptureResult.SENSOR_SENSITIVITY) == iso && result.get(CaptureResult.SENSOR_EXPOSURE_TIME) == nanos
                                }
                            } finally {
                                receipt.put("actualAeMode", captureProbe.latest.get()?.get(CaptureResult.CONTROL_AE_MODE))
                                    .put("actualIso", captureProbe.latest.get()?.get(CaptureResult.SENSOR_SENSITIVITY))
                                    .put("actualNanos", captureProbe.latest.get()?.get(CaptureResult.SENSOR_EXPOSURE_TIME))
                            }
                            val settings = call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings")
                            assertEquals("manual", settings.getString("exposureMode"))
                            assertEquals(iso, settings.getInt("iso"))
                            assertEquals(nanos / 1e9, settings.getDouble("shutterSpeed"), 0.000000001)
                        }
                        val result = call(scenario, "setSettings", "{settings:{exposureMode:'manual',iso:$iso,shutterSpeed:${nanos / 1e9}}}")
                        receipts.put(JSONObject().put("manualSensorSupported", true).put("result", result))
                        assertTrue("Manual exposure failed: $result", result.getBoolean("ok"))
                        inspect("selected")
                        assertTrue(call(scenario, "setSettings", "{settings:{focusMode:'manual'}}").getBoolean("ok"))
                        inspect("focus-changed")
                        assertTrue(call(scenario, "stopPreview").getBoolean("ok"))
                        preview(scenario)
                        inspect("preview-restarted")
                        iso = isoRange.lower
                        assertTrue(call(scenario, "setSettings", "{settings:{iso:$iso}}").getBoolean("ok"))
                        inspect("iso-only")
                        val zeroEv = call(scenario, "setSettings", "{settings:{exposureCompensation:0}}")
                        assertTrue("Zero EV must settle while manual exposure is active: $zeroEv", zeroEv.getBoolean("ok"))
                        inspect("manual-zero-ev")
                        if (info.hasFlashUnit()) {
                            assertTrue(call(scenario, "setSettings", "{settings:{flash:'torch'}}").getBoolean("ok"))
                            inspect("manual-torch")
                            assertEquals(CaptureResult.FLASH_MODE_TORCH, probe.latest.get()?.get(CaptureResult.FLASH_MODE))
                            assertTrue(call(scenario, "setSettings", "{settings:{flash:'off'}}").getBoolean("ok"))
                        }
                        nanos = 20_000_000L.coerceIn(timeRange.lower, timeRange.upper)
                        assertTrue(call(scenario, "setSettings", "{settings:{shutterSpeed:${nanos / 1e9}}}").getBoolean("ok"))
                        inspect("shutter-only")
                        assertTrue(call(scenario, "setSettings", "{settings:{exposureMode:'manual'}}").getBoolean("ok"))
                        inspect("lock-observed")
                        assertTrue(call(scenario, "startRecording", "{audio:false,quality:'low'}").getBoolean("ok"))
                        try {
                            inspect("recording")
                            awaitState("Manual-exposure video must contain encoded media") {
                                val state = call(scenario, "getRecordingState").getJSONObject("value")
                                state.getLong("fileSize") > 0 && state.getDouble("duration") > 0
                            }
                        } finally {
                            val stopped = call(scenario, "stopRecording")
                            assertTrue(stopped.toString(), stopped.getBoolean("ok"))
                            val file = java.io.File(requireNotNull(android.net.Uri.parse(stopped.getJSONObject("value").getString("path")).path))
                            assertEquals(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir.canonicalFile, file.canonicalFile.parentFile)
                            assertTrue(file.delete())
                        }
                        val front = cameraInfo(CameraSelector.DEFAULT_FRONT_CAMERA)
                        val frontDetails = Camera2CameraInfo.from(front)
                        val frontSupports = CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR in
                            (frontDetails.getCameraCharacteristic(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES) ?: intArrayOf()) &&
                            frontDetails.getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE)?.contains(iso) == true &&
                            frontDetails.getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE)?.contains(nanos) == true
                        CaptureProbe(front).use { frontProbe ->
                            val switched = call(scenario, "switchCamera", "{direction:'front'}")
                            receipts.put(JSONObject().put("stage", "switch").put("supported", frontSupports).put("result", switched))
                            if (frontSupports) {
                                assertTrue(switched.toString(), switched.getBoolean("ok"))
                                inspect("front", frontProbe)
                                assertTrue(call(scenario, "switchCamera", "{direction:'back'}").getBoolean("ok"))
                                inspect("back")
                            } else assertFalse("Unsupported target must reject before unbinding", switched.getBoolean("ok"))
                        }
                        val ev = if (info.exposureState.isExposureCompensationSupported) info.exposureState.exposureCompensationStep.toDouble() else null
                        val automaticOptions = if (ev == null) "{settings:{exposureMode:'continuous'}}" else "{settings:{exposureMode:'continuous',exposureCompensation:$ev}}"
                        val automatic = call(scenario, "setSettings", automaticOptions)
                        assertTrue("Leaving manual mode with EV must settle: $automatic", automatic.getBoolean("ok"))
                        val count = probe.frames.get()
                        awaitState("Continuous exposure must release manual sensor override") {
                            probe.frames.get() >= count + 3 && probe.latest.get()?.get(CaptureResult.CONTROL_AE_MODE) == CaptureResult.CONTROL_AE_MODE_ON
                        }
                        receipts.put(JSONObject().put("stage", "continuous").put("actualAeMode", probe.latest.get()?.get(CaptureResult.CONTROL_AE_MODE)))
                        if (ev != null) assertTrue(call(scenario, "setSettings", "{settings:{exposureCompensation:0}}").getBoolean("ok"))
                        assertTrue(call(scenario, "setSettings", "{settings:{iso:$iso,shutterSpeed:${nanos / 1e9}}}").getBoolean("ok"))
                        inspect("implicit-manual")
                        val point = call(scenario, "setExposurePoint", "{x:0.25,y:0.75}")
                        assertTrue(point.toString(), point.getBoolean("ok"))
                        val pointCount = probe.frames.get()
                        awaitState("Exposure point must exit manual mode") {
                            probe.frames.get() >= pointCount + 3 && probe.latest.get()?.get(CaptureResult.CONTROL_AE_MODE) == CaptureResult.CONTROL_AE_MODE_ON &&
                                probe.latest.get()?.get(CaptureResult.CONTROL_AE_REGIONS)?.any { it.meteringWeight > 0 } == true
                        }
                        assertEquals("continuous", call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings").getString("exposureMode"))
                        receipts.put(JSONObject().put("stage", "exposure-point").put("result", point).put("actualAeMode", probe.latest.get()?.get(CaptureResult.CONTROL_AE_MODE)))
                    }
                }
            } finally {
                call(scenario, "stopPreview")
                emit("camera-manual-exposure.json", receipts)
            }
        }
    }

    @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
    @Test fun exposureBatchesRejectRangeAndModeConflictsBeforeMutation() {
        val receipts = JSONArray()
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            preview(scenario)
            val details = Camera2CameraInfo.from(cameraInfo())
            val isoRange = details.getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE)
            val timeRange = details.getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE)
            val capabilities = details.getCameraCharacteristic(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES) ?: intArrayOf()
            try {
                CaptureProbe(cameraInfo()).use { probe ->
                    awaitState("Need native exposure metadata") { probe.latest.get() != null }
                    val manualSupported = CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR in capabilities
                    val cases = mutableListOf("{whiteBalance:'daylight',exposureMode:'continuous',iso:100}" to "EXPOSURE_CONFLICT")
                    if (manualSupported) {
                        cases.add("{whiteBalance:'daylight',iso:${requireNotNull(isoRange).upper.toLong() + 1}}" to "EXPOSURE_OUT_OF_RANGE")
                        cases.add("{whiteBalance:'daylight',shutterSpeed:${requireNotNull(timeRange).upper / 1e9 + 1.0}}" to "EXPOSURE_OUT_OF_RANGE")
                        cases.add("{whiteBalance:'daylight',exposureMode:'manual',exposureCompensation:0.25}" to "EXPOSURE_CONFLICT")
                        if (cameraInfo().hasFlashUnit()) cases.add("{whiteBalance:'daylight',exposureMode:'manual',flash:'auto'}" to "EXPOSURE_CONFLICT")
                    }
                    val baseline = call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings").toString()
                    val beforeAwb = probe.latest.get()?.get(CaptureResult.CONTROL_AWB_MODE)
                    for ((settings, code) in cases) {
                        val result = call(scenario, "setSettings", "{settings:$settings}")
                        receipts.put(JSONObject().put("settings", settings).put("result", result))
                        assertFalse(result.toString(), result.getBoolean("ok"))
                        assertEquals(code, result.getString("code"))
                        assertEquals(baseline, call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings").toString())
                        val count = probe.frames.get()
                        awaitState("Need captures after rejected batch") { probe.frames.get() >= count + 3 }
                        assertEquals(beforeAwb, probe.latest.get()?.get(CaptureResult.CONTROL_AWB_MODE))
                    }
                }
            } finally { call(scenario, "stopPreview"); emit("camera-sensor-preflight.json", receipts) }
        }
    }

    @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
    @Test fun singleShotExposureLocksAfterConvergence_andContinuousReleasesLock() {
        val receipts = JSONArray()
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            preview(scenario)
            val supportsLock = Camera2CameraInfo.from(cameraInfo()).getCameraCharacteristic(CameraCharacteristics.CONTROL_AE_LOCK_AVAILABLE) == true
            try {
                CaptureProbe(cameraInfo()).use { probe ->
                    val result = call(scenario, "setSettings", "{settings:{exposureMode:'auto'}}")
                    receipts.put(JSONObject().put("supportsLock", supportsLock).put("result", result))
                    if (!supportsLock) {
                        assertFalse(result.getBoolean("ok")); assertEquals("EXPOSURE_UNSUPPORTED", result.getString("code"))
                    } else {
                        assertTrue(result.toString(), result.getBoolean("ok"))
                        val count = probe.frames.get()
                        awaitState("Single shot exposure must be locked") {
                            probe.frames.get() >= count + 3 && probe.latest.get()?.get(CaptureResult.CONTROL_AE_LOCK) == true
                        }
                        receipts.put(JSONObject().put("stage", "auto").put("aeMode", probe.latest.get()?.get(CaptureResult.CONTROL_AE_MODE))
                            .put("aeLock", probe.latest.get()?.get(CaptureResult.CONTROL_AE_LOCK)).put("aeState", probe.latest.get()?.get(CaptureResult.CONTROL_AE_STATE)))
                        assertEquals(CaptureResult.CONTROL_AE_STATE_LOCKED, probe.latest.get()?.get(CaptureResult.CONTROL_AE_STATE))
                        assertTrue(call(scenario, "setSettings", "{settings:{focusMode:'manual'}}").getBoolean("ok"))
                        val focusCount = probe.frames.get()
                        awaitState("Changing focus must retain the exposure lock") {
                            probe.frames.get() >= focusCount + 3 && probe.latest.get()?.get(CaptureResult.CONTROL_AE_LOCK) == true
                        }
                        assertTrue(call(scenario, "stopPreview").getBoolean("ok"))
                        preview(scenario)
                        val restartedCount = probe.frames.get()
                        awaitState("Single-shot exposure must converge and lock again after restart") {
                            probe.frames.get() >= restartedCount + 3 && probe.latest.get()?.get(CaptureResult.CONTROL_AE_LOCK) == true &&
                                probe.latest.get()?.get(CaptureResult.CONTROL_AE_STATE) == CaptureResult.CONTROL_AE_STATE_LOCKED
                        }
                        receipts.put(JSONObject().put("stage", "restarted").put("aeLock", probe.latest.get()?.get(CaptureResult.CONTROL_AE_LOCK))
                            .put("aeState", probe.latest.get()?.get(CaptureResult.CONTROL_AE_STATE)))
                        assertTrue(call(scenario, "setSettings", "{settings:{exposureMode:'continuous'}}").getBoolean("ok"))
                        val continuousCount = probe.frames.get()
                        awaitState("Continuous exposure must unlock") {
                            probe.frames.get() >= continuousCount + 3 && probe.latest.get()?.get(CaptureResult.CONTROL_AE_LOCK) == false
                        }
                        receipts.put(JSONObject().put("stage", "continuous").put("aeLock", probe.latest.get()?.get(CaptureResult.CONTROL_AE_LOCK)))
                    }
                }
            } finally { call(scenario, "stopPreview"); emit("camera-auto-exposure.json", receipts) }
        }
    }

    @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
    @Test fun manualExposureReachesPhotoExifAndEncodedFormats() {
        val receipts = JSONArray()
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            preview(scenario)
            val details = Camera2CameraInfo.from(cameraInfo())
            val capabilities = details.getCameraCharacteristic(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES) ?: intArrayOf()
            try {
                if (CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR !in capabilities) {
                    val rejected = call(scenario, "setSettings", "{settings:{iso:100,shutterSpeed:0.01}}")
                    receipts.put(JSONObject().put("manualSensorSupported", false).put("result", rejected))
                    assertFalse(rejected.getBoolean("ok"))
                    assertEquals("EXPOSURE_UNSUPPORTED", rejected.getString("code"))
                } else {
                    val isoRange = requireNotNull(details.getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE))
                    val timeRange = requireNotNull(details.getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE))
                    for ((index, format) in listOf("jpeg", "png", "webp").withIndex()) {
                        val iso = isoRange.lower + (isoRange.upper - isoRange.lower) * (index + 1) / 4
                        val nanos = ((index + 1) * 10_000_000L).coerceIn(timeRange.lower, timeRange.upper)
                        val settingsResult = call(scenario, "setSettings", "{settings:{iso:$iso,shutterSpeed:${nanos / 1e9}}}")
                        assertTrue(settingsResult.toString(), settingsResult.getBoolean("ok"))
                        val result = call(scenario, "capturePhoto", "{format:'$format',quality:85,width:320,height:240,exifOrientation:true}")
                        val receipt = JSONObject().put("format", format).put("requestedIso", iso).put("requestedNanos", nanos)
                            .put("ok", result.getBoolean("ok"))
                        receipts.put(receipt)
                        if (!result.getBoolean("ok")) receipt.put("error", result)
                        assertTrue("Photo capture failed: $result", result.getBoolean("ok"))
                        val photo = result.getJSONObject("value")
                        val bytes = Base64.decode(photo.getString("base64"), Base64.DEFAULT)
                        if (format == "webp") {
                            emit("camera-manual-webp.json", JSONArray().put(JSONObject().put("format", format).put("base64", photo.getString("base64"))))
                        } else InstrumentationRegistry.getInstrumentation().sendStatus(2, Bundle().apply {
                            putString("nativeArtifactName", if (format == "jpeg") "camera-manual.jpg" else "camera-manual.png")
                            putString("nativeArtifactBase64", Base64.encodeToString(bytes, Base64.NO_WRAP))
                        })
                        val dimensions = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
                        android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, dimensions)
                        val bitmap = requireNotNull(android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size))
                        try {
                            receipt.put("bytes", bytes.size).put("decodedMime", dimensions.outMimeType)
                                .put("decodedWidth", bitmap.width).put("decodedHeight", bitmap.height)
                                .put("returnedWidth", photo.getInt("width")).put("returnedHeight", photo.getInt("height"))
                                .put("exif", photo.optJSONObject("exif"))
                            assertEquals("image/$format", dimensions.outMimeType)
                            assertEquals(320, bitmap.width); assertEquals(240, bitmap.height)
                            assertEquals(bitmap.width, photo.getInt("width")); assertEquals(bitmap.height, photo.getInt("height"))
                            val exif = photo.getJSONObject("exif")
                            assertEquals("Still-photo ISO must match the manual request", iso, exif.getString("ISO").toInt())
                            assertEquals("Still-photo shutter must match the manual request", nanos / 1e9, exif.getString("ExposureTime").toDouble(), 0.000001)
                        } finally { bitmap.recycle() }
                    }
                }
            } finally {
                call(scenario, "stopPreview")
                emit("camera-photo-exposure.json", receipts)
            }
        }
    }

    @Test fun malformedPhotoOptionsRejectWithoutEncodingAnAlternativeFormat() {
        val receipts = JSONArray()
        val failures = mutableListOf<String>()
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            preview(scenario)
            try {
                for (options in listOf("{format:'gif'}", "{format:17}", "{quality:-1}", "{quality:101}",
                    "{quality:'85'}", "{quality:null}", "{width:0,height:240}", "{width:-1,height:240}",
                    "{width:160.5,height:240}", "{width:'160',height:240}", "{height:0}",
                    "{saveToGallery:0}", "{exifOrientation:'true'}", "{unknownPhotoOption:true}",
                    "{width:2147483648,height:240}", "{width:2147483647,height:240}", "{width:1,height:2147483647}")) {
                    val result = call(scenario, "capturePhoto", options)
                    val receipt = JSONObject().put("options", options).put("ok", result.getBoolean("ok"))
                        .put("code", result.optString("code")).put("error", result.optString("error"))
                    if (result.getBoolean("ok")) {
                        val value = result.getJSONObject("value")
                        val bytes = Base64.decode(value.getString("base64"), Base64.DEFAULT)
                        val decoded = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
                        android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, decoded)
                        receipt.put("reportedFormat", value.getString("format")).put("actualMime", decoded.outMimeType)
                    }
                    receipts.put(receipt)
                    if (result.getBoolean("ok") || result.optString("code") != "INVALID_ARGUMENT") failures.add(options)
                }
                assertTrue("Malformed photo options must reject with INVALID_ARGUMENT: $failures", failures.isEmpty())
            } finally { call(scenario, "stopPreview"); emit("camera-photo-invalid.json", receipts) }
        }
    }

    @Test fun photoDimensionsAndOptionalExifMatchDecodedOutput() {
        val receipts = JSONArray()
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            preview(scenario)
            try {
                fun photo(options: String): JSONObject {
                    val result = call(scenario, "capturePhoto", options)
                    assertTrue("Photo failed: ${result.optString("error")}", result.getBoolean("ok"))
                    val value = result.getJSONObject("value")
                    val bytes = Base64.decode(value.getString("base64"), Base64.DEFAULT)
                    val bitmap = requireNotNull(android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size))
                    try {
                        assertEquals(bitmap.width, value.getInt("width")); assertEquals(bitmap.height, value.getInt("height"))
                        assertFalse("EXIF is opt-in on Android", value.has("exif"))
                        receipts.put(JSONObject().put("options", options).put("width", bitmap.width).put("height", bitmap.height).put("bytes", bytes.size))
                    } finally { bitmap.recycle() }
                    return value
                }
                val original = photo("{}")
                val widthOnly = photo("{width:160,quality:0,exifOrientation:false}")
                assertEquals("A width-only request must be applied", 160, widthOnly.getInt("width"))
                assertEquals(original.getInt("height"), widthOnly.getInt("height"))
                val heightOnly = photo("{height:120,quality:100}")
                assertEquals(original.getInt("width"), heightOnly.getInt("width"))
                assertEquals("A height-only request must be applied", 120, heightOnly.getInt("height"))
            } finally { call(scenario, "stopPreview"); emit("camera-photo-dimensions.json", receipts) }
        }
    }

    @Test fun flashSettingsRequireActiveCameraWithoutChangingCache() {
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            ready(scenario)
            val before = call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings")
            val result = call(scenario, "setSettings", "{settings:{flash:'torch'}}")
            val after = call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings")
            emit("camera-flash-inactive.json", JSONArray().put(JSONObject().put("result", result).put("before", before).put("after", after)))
            assertFalse("Inactive torch cannot report success", result.getBoolean("ok"))
            assertEquals("CAMERA_INACTIVE", result.getString("code"))
            assertEquals(before.toString(), after.toString())
        }
    }

    @Test fun exposureCompensationUsesNearestNativeStepAndReportsAppliedEv() {
        val receipts = JSONArray()
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            preview(scenario)
            try {
                val info = cameraInfo()
                val state = info.exposureState
                if (!state.isExposureCompensationSupported) {
                    val result = call(scenario, "setSettings", "{settings:{exposureCompensation:1}}")
                    receipts.put(JSONObject().put("supported", false).put("result", result))
                    assertFalse(result.getBoolean("ok"))
                    assertEquals("EXPOSURE_UNSUPPORTED", result.getString("code"))
                } else {
                    val step = state.exposureCompensationStep.toDouble()
                    val bounds = state.exposureCompensationRange
                    val requests = mutableListOf<Pair<Double, Int>>()
                    if (bounds.upper >= 1) requests.add(step * 0.75 to 1)
                    if (bounds.lower <= -1) requests.add(-step * 0.75 to -1)
                    requests.add(0.0 to 0)
                    CaptureProbe(info).use { probe ->
                        for ((ev, index) in requests) {
                            val result = call(scenario, "setSettings", "{settings:{exposureCompensation:$ev}}")
                            val receipt = JSONObject().put("requestedEv", ev).put("step", step)
                                .put("expectedIndex", index).put("result", result)
                            receipts.put(receipt)
                            assertTrue("Exposure request failed: $result", result.getBoolean("ok"))
                            try {
                                awaitState("Exposure compensation must reach native step $index") {
                                    probe.latest.get()?.get(CaptureResult.CONTROL_AE_EXPOSURE_COMPENSATION) == index
                                }
                            } finally { receipt.put("actualIndex", probe.latest.get()?.get(CaptureResult.CONTROL_AE_EXPOSURE_COMPENSATION)) }
                            assertEquals(index, info.exposureState.exposureCompensationIndex)
                            val settings = call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings")
                            receipt.put("reportedEv", settings.getDouble("exposureCompensation"))
                            assertEquals("Settings report applied EV, not an unrepresentable request", index * step,
                                settings.getDouble("exposureCompensation"), 0.000001)
                        }
                        val before = call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings")
                        val beforeMode = probe.latest.get()?.get(CaptureResult.CONTROL_AWB_MODE)
                        val result = call(scenario, "setSettings", "{settings:{whiteBalance:'daylight',exposureCompensation:${(bounds.upper + 1) * step}}}")
                        val after = call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings")
                        val count = probe.frames.get()
                        awaitState("Need new captures after rejection") { probe.frames.get() >= count + 3 }
                        receipts.put(JSONObject().put("stage", "out-of-range-batch").put("result", result)
                            .put("beforeSettings", before).put("afterSettings", after)
                            .put("beforeWhiteBalanceMode", beforeMode).put("afterWhiteBalanceMode", probe.latest.get()?.get(CaptureResult.CONTROL_AWB_MODE)))
                        assertFalse("Out-of-range EV cannot be silently clamped", result.getBoolean("ok"))
                        assertEquals("EXPOSURE_OUT_OF_RANGE", result.getString("code"))
                        assertEquals(before.toString(), after.toString())
                        assertEquals(beforeMode, probe.latest.get()?.get(CaptureResult.CONTROL_AWB_MODE))
                        assertEquals(0, info.exposureState.exposureCompensationIndex)
                    }
                }
            } finally {
                call(scenario, "stopPreview")
                emit("camera-exposure-compensation.json", receipts)
            }
        }
    }

    @Test fun invalidSettingsRejectWithoutChangingAnyCachedField() {
        val receipts = JSONArray()
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            preview(scenario)
            val before = call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings")
            val beforeZoom = requireNotNull(cameraInfo().zoomState.value).zoomRatio
            try {
                for (options in listOf(
                    "{}", "{settings:null}", "{settings:[]}", "{settings:'auto'}",
                    "{settings:{zoom:0}}", "{settings:{zoom:-1}}", "{settings:{zoom:'2'}}",
                    "{settings:{zoom:null}}", "{settings:{zoom:1e100}}",
                    "{settings:{flash:'invalid'}}", "{settings:{flash:1}}",
                    "{settings:{focusMode:'fixed'}}", "{settings:{exposureMode:'locked'}}",
                    "{settings:{whiteBalance:'sunny'}}", "{settings:{exposureCompensation:'1'}}",
                    "{settings:{iso:0}}", "{settings:{iso:1.5}}", "{settings:{iso:2147483648}}",
                    "{settings:{shutterSpeed:0}}", "{settings:{shutterSpeed:true}}",
                    "{settings:{shutterSpeed:1e100}}", "{settings:{zoom:2,unknown:true}}"
                )) {
                    val result = call(scenario, "setSettings", options)
                    val after = call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings")
                    receipts.put(JSONObject().put("options", options).put("result", result).put("settings", after))
                    assertFalse("Invalid settings must reject: $options => $result", result.getBoolean("ok"))
                    assertEquals("INVALID_ARGUMENT", result.getString("code"))
                    assertEquals("Rejected settings must not mutate cache: $options", before.toString(), after.toString())
                    assertEquals("Rejected batch must not apply its valid zoom field", beforeZoom.toDouble(),
                        requireNotNull(cameraInfo().zoomState.value).zoomRatio.toDouble(), 0.001)
                }
            } finally {
                call(scenario, "stopPreview")
                emit("camera-settings-invalid.json", receipts)
            }
        }
    }

    @Test fun inactiveControlsRejectInsteadOfReportingSuccess() {
        val receipts = JSONArray()
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            ready(scenario)
            try {
                for ((method, options) in listOf("setSettings" to "{settings:{iso:100}}", "setSettings" to "{settings:{shutterSpeed:0.01}}", "setSettings" to "{settings:{exposureMode:'manual'}}", "setSettings" to "{settings:{focusMode:'manual'}}", "setZoom" to "{zoom:1}", "setSettings" to "{settings:{zoom:1}}", "setSettings" to "{settings:{exposureCompensation:1}}", "setSettings" to "{settings:{whiteBalance:'auto'}}", "setFocusPoint" to "{x:0.5,y:0.5}", "setExposurePoint" to "{x:0.5,y:0.5}")) {
                    val result = call(scenario, method, options)
                    receipts.put(JSONObject().put("method", method).put("result", result))
                    assertFalse("Inactive $method must reject", result.getBoolean("ok"))
                    assertEquals("CAMERA_INACTIVE", result.getString("code"))
                }
            } finally { emit("camera-control-inactive.json", receipts) }
        }
    }

    @Test fun meteringValidatesCoordinates_andReportsDeviceCapability() {
        val receipts = JSONArray()
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            preview(scenario)
            try {
                CaptureProbe(cameraInfo()).use { probe ->
                    for ((method, flag) in listOf("setFocusPoint" to FocusMeteringAction.FLAG_AF, "setExposurePoint" to FocusMeteringAction.FLAG_AE)) {
                        for (options in listOf("{}", "{x:-0.1,y:0.5}", "{x:0.5,y:1.1}", "{x:'0.5',y:0.5}")) {
                            val result = call(scenario, method, options)
                            receipts.put(JSONObject().put("method", method).put("options", options).put("result", result))
                            assertFalse("Invalid $method coordinates must reject", result.getBoolean("ok"))
                        }
                        val point = SurfaceOrientedMeteringPointFactory(1f, 1f).createPoint(0.5f, 0.5f)
                        val supported = cameraInfo().isFocusMeteringSupported(FocusMeteringAction.Builder(point, flag).build())
                        val result = call(scenario, method, "{x:0.25,y:0.75}")
                        receipts.put(JSONObject().put("method", method).put("supported", supported).put("result", result))
                        if (!supported) {
                            assertFalse("Unsupported metering must reject", result.getBoolean("ok"))
                            assertEquals("METERING_UNSUPPORTED", result.getString("code"))
                        } else {
                            assertTrue("Supported metering must settle successfully: $result", result.getBoolean("ok"))
                            val key = if (flag == FocusMeteringAction.FLAG_AF) CaptureResult.CONTROL_AF_REGIONS else CaptureResult.CONTROL_AE_REGIONS
                            fun regions() = probe.latest.get()?.get(key)?.filter { it.meteringWeight > 0 }?.map { it.rect.toShortString() }.orEmpty()
                            awaitState("Camera2 must report active $method regions") { regions().isNotEmpty() }
                            val first = regions()
                            val second = call(scenario, method, "{x:0.75,y:0.25}")
                            assertTrue("Second metering point failed: $second", second.getBoolean("ok"))
                            awaitState("A different point must change Camera2 metering regions") {
                                regions().isNotEmpty() && regions() != first
                            }
                            receipts.put(JSONObject().put("method", method).put("firstCamera2Regions", JSONArray(first))
                                .put("secondCamera2Regions", JSONArray(regions())).put("secondResult", second))
                        }
                    }
                }
            } finally {
                call(scenario, "stopPreview")
                emit("camera-control-metering.json", receipts)
            }
        }
    }
    @Test fun stoppingPreviewRejectsPendingMetering_withoutChangingCachedMode() {
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            preview(scenario)
            val before = call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings").getString("focusMode")
            val settled = CountDownLatch(1)
            val stopped = CountDownLatch(1)
            val settlements = AtomicInteger()
            var rejectedCode: String? = null
            var resolved = false
            val pending = object : PluginCall(null, "ElizaCamera", "pending-metering", "setFocusPoint",
                JSObject().put("x", 0.5).put("y", 0.5)) {
                override fun resolve() { resolved = true; settlements.incrementAndGet(); settled.countDown() }
                override fun reject(message: String?, code: String?, error: Exception?, data: JSObject?) {
                    rejectedCode = code; settlements.incrementAndGet(); settled.countDown()
                }
            }
            val stopping = object : PluginCall(null, "ElizaCamera", "stop-metering", "stopPreview", JSObject()) {
                override fun resolve() { stopped.countDown() }
            }
            // One UI dispatch guarantees stop runs before the completion listener.
            // Only reply transport is intercepted; CameraX and plugin lifecycle are real.
            scenario.onActivity { activity ->
                val plugin = activity.bridge.getPlugin("ElizaCamera").instance as CameraPlugin
                plugin.setFocusPoint(pending)
                plugin.stopPreview(stopping)
            }
            assertTrue("Stop did not settle", stopped.await(10, TimeUnit.SECONDS))
            assertTrue("Pending metering did not settle", settled.await(10, TimeUnit.SECONDS))
            assertFalse("Cancelled control cannot report success", resolved)
            assertTrue("Expected lifecycle/camera cancellation: $rejectedCode",
                rejectedCode in setOf("CAMERA_INACTIVE", "CAMERA_CONTROL_FAILED"))
            assertEquals(1, settlements.get())
            val after = call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings").getString("focusMode")
            assertEquals("Cancelled operation must not update settings", before, after)
            emit("camera-control-cancellation.json", JSONArray().put(JSONObject()
                .put("resolved", resolved).put("rejectedCode", rejectedCode).put("settlements", settlements.get())
                .put("beforeFocusMode", before).put("afterFocusMode", after)
                .put("transport", "Native PluginCall replies; same-dispatch lifecycle cancellation")))
        }
    }

    @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
    @Test fun stoppingPreviewRejectsPendingWhiteBalance_withoutChangingCachedPreset() {
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            preview(scenario)
            val before = call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings").getString("whiteBalance")
            val modes = Camera2CameraInfo.from(cameraInfo()).getCameraCharacteristic(CameraCharacteristics.CONTROL_AWB_AVAILABLE_MODES) ?: intArrayOf()
            val target = if (CaptureResult.CONTROL_AWB_MODE_DAYLIGHT in modes) "daylight" else "auto"
            val settled = CountDownLatch(1)
            val stopped = CountDownLatch(1)
            val settlements = AtomicInteger()
            var rejectedCode: String? = null
            var resolved = false
            val pending = object : PluginCall(null, "ElizaCamera", "pending-metering", "setSettings",
                JSObject().put("settings", JSObject().put("whiteBalance", target))) {
                override fun resolve() { resolved = true; settlements.incrementAndGet(); settled.countDown() }
                override fun reject(message: String?, code: String?, error: Exception?, data: JSObject?) {
                    rejectedCode = code; settlements.incrementAndGet(); settled.countDown()
                }
            }
            val stopping = object : PluginCall(null, "ElizaCamera", "stop-metering", "stopPreview", JSObject()) {
                override fun resolve() { stopped.countDown() }
            }
            // One UI dispatch guarantees stop runs before the completion listener.
            // Only reply transport is intercepted; CameraX and plugin lifecycle are real.
            scenario.onActivity { activity ->
                val plugin = activity.bridge.getPlugin("ElizaCamera").instance as CameraPlugin
                plugin.setSettings(pending)
                plugin.stopPreview(stopping)
            }
            assertTrue("Stop did not settle", stopped.await(10, TimeUnit.SECONDS))
            assertTrue("Pending metering did not settle", settled.await(10, TimeUnit.SECONDS))
            assertFalse("Cancelled control cannot report success", resolved)
            assertTrue("Expected lifecycle/camera cancellation: $rejectedCode",
                rejectedCode in setOf("CAMERA_INACTIVE", "CAMERA_CONTROL_FAILED"))
            assertEquals(1, settlements.get())
            val after = call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings").getString("whiteBalance")
            assertEquals("Cancelled operation must not update settings", before, after)
            emit("camera-white-balance-cancellation.json", JSONArray().put(JSONObject()
                .put("resolved", resolved).put("rejectedCode", rejectedCode).put("settlements", settlements.get())
                .put("requestedPreset", target).put("beforePreset", before).put("afterPreset", after)
                .put("transport", "Native PluginCall replies; same-dispatch lifecycle cancellation")))
        }
    }

    @Test fun stoppingPreviewRejectsPendingExposure_withoutChangingConfirmedEv() {
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            preview(scenario)
            val before = call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings").getDouble("exposureCompensation")
            val state = cameraInfo().exposureState
            val target = if (state.isExposureCompensationSupported) state.exposureCompensationStep.toDouble() * 0.75 else 1.0
            val settled = CountDownLatch(1)
            val stopped = CountDownLatch(1)
            val settlements = AtomicInteger()
            var rejectedCode: String? = null
            var resolved = false
            val pending = object : PluginCall(null, "ElizaCamera", "pending-metering", "setSettings",
                JSObject().put("settings", JSObject().put("exposureCompensation", target))) {
                override fun resolve() { resolved = true; settlements.incrementAndGet(); settled.countDown() }
                override fun reject(message: String?, code: String?, error: Exception?, data: JSObject?) {
                    rejectedCode = code; settlements.incrementAndGet(); settled.countDown()
                }
            }
            val stopping = object : PluginCall(null, "ElizaCamera", "stop-metering", "stopPreview", JSObject()) {
                override fun resolve() { stopped.countDown() }
            }
            // One UI dispatch guarantees stop runs before the completion listener.
            // Only reply transport is intercepted; CameraX and plugin lifecycle are real.
            scenario.onActivity { activity ->
                val plugin = activity.bridge.getPlugin("ElizaCamera").instance as CameraPlugin
                plugin.setSettings(pending)
                plugin.stopPreview(stopping)
            }
            assertTrue("Stop did not settle", stopped.await(10, TimeUnit.SECONDS))
            assertTrue("Pending metering did not settle", settled.await(10, TimeUnit.SECONDS))
            assertFalse("Cancelled control cannot report success", resolved)
            val expectedCodes = if (state.isExposureCompensationSupported) setOf("CAMERA_INACTIVE", "CAMERA_CONTROL_FAILED") else setOf("EXPOSURE_UNSUPPORTED")
            assertTrue("Expected lifecycle/camera cancellation: $rejectedCode", rejectedCode in expectedCodes)
            assertEquals(1, settlements.get())
            val after = call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings").getDouble("exposureCompensation")
            assertEquals("Cancelled operation must not update settings", before, after, 0.000001)
            preview(scenario)
            assertEquals(0, cameraInfo().exposureState.exposureCompensationIndex)
            call(scenario, "stopPreview")
            emit("camera-exposure-cancellation.json", JSONArray().put(JSONObject()
                .put("resolved", resolved).put("rejectedCode", rejectedCode).put("settlements", settlements.get())
                .put("supported", state.isExposureCompensationSupported).put("requestedEv", target).put("beforeEv", before).put("afterEv", after)
                .put("transport", "Native PluginCall replies; same-dispatch lifecycle cancellation")))
        }
    }

    @Test fun stoppingPreviewRejectsPendingBatchZoom_withoutChangingConfirmedRatio() {
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            preview(scenario)
            val before = call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings").getDouble("zoom")
            val state = requireNotNull(cameraInfo().zoomState.value)
            val target = (state.minZoomRatio + state.maxZoomRatio) / 2
            val settled = CountDownLatch(1)
            val stopped = CountDownLatch(1)
            val settlements = AtomicInteger()
            var rejectedCode: String? = null
            var resolved = false
            val pending = object : PluginCall(null, "ElizaCamera", "pending-metering", "setSettings",
                JSObject().put("settings", JSObject().put("zoom", target))) {
                override fun resolve() { resolved = true; settlements.incrementAndGet(); settled.countDown() }
                override fun reject(message: String?, code: String?, error: Exception?, data: JSObject?) {
                    rejectedCode = code; settlements.incrementAndGet(); settled.countDown()
                }
            }
            val stopping = object : PluginCall(null, "ElizaCamera", "stop-metering", "stopPreview", JSObject()) {
                override fun resolve() { stopped.countDown() }
            }
            // One UI dispatch guarantees stop runs before the completion listener.
            // Only reply transport is intercepted; CameraX and plugin lifecycle are real.
            scenario.onActivity { activity ->
                val plugin = activity.bridge.getPlugin("ElizaCamera").instance as CameraPlugin
                plugin.setSettings(pending)
                plugin.stopPreview(stopping)
            }
            assertTrue("Stop did not settle", stopped.await(10, TimeUnit.SECONDS))
            assertTrue("Pending metering did not settle", settled.await(10, TimeUnit.SECONDS))
            assertFalse("Cancelled control cannot report success", resolved)
            val expectedCodes = setOf("CAMERA_INACTIVE", "CAMERA_CONTROL_FAILED")
            assertTrue("Expected lifecycle/camera cancellation: $rejectedCode", rejectedCode in expectedCodes)
            assertEquals(1, settlements.get())
            val after = call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings").getDouble("zoom")
            assertEquals("Cancelled operation must not update settings", before, after, 0.000001)
            preview(scenario)
            assertEquals(before, requireNotNull(cameraInfo().zoomState.value).zoomRatio.toDouble(), 0.001)
            call(scenario, "stopPreview")
            emit("camera-settings-zoom-cancellation.json", JSONArray().put(JSONObject()
                .put("resolved", resolved).put("rejectedCode", rejectedCode).put("settlements", settlements.get())
                .put("requestedRatio", target.toDouble()).put("beforeRatio", before).put("afterRatio", after)
                .put("transport", "Native PluginCall replies; same-dispatch lifecycle cancellation")))
        }
    }

    @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
    @Test fun stoppingPreviewRejectsPendingSensorExposure_withoutRetainingManualMode() {
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            preview(scenario)
            val before = call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings").getString("exposureMode")
            val supported = CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR in (Camera2CameraInfo.from(cameraInfo()).getCameraCharacteristic(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES) ?: intArrayOf())
            val target = "manual"
            val settled = CountDownLatch(1)
            val stopped = CountDownLatch(1)
            val settlements = AtomicInteger()
            var rejectedCode: String? = null
            var resolved = false
            val pending = object : PluginCall(null, "ElizaCamera", "pending-metering", "setSettings",
                JSObject().put("settings", JSObject().put("exposureMode", target).put("iso", 100).put("shutterSpeed", 0.01))) {
                override fun resolve() { resolved = true; settlements.incrementAndGet(); settled.countDown() }
                override fun reject(message: String?, code: String?, error: Exception?, data: JSObject?) {
                    rejectedCode = code; settlements.incrementAndGet(); settled.countDown()
                }
            }
            val stopping = object : PluginCall(null, "ElizaCamera", "stop-metering", "stopPreview", JSObject()) {
                override fun resolve() { stopped.countDown() }
            }
            // One UI dispatch guarantees stop runs before the completion listener.
            // Only reply transport is intercepted; CameraX and plugin lifecycle are real.
            scenario.onActivity { activity ->
                val plugin = activity.bridge.getPlugin("ElizaCamera").instance as CameraPlugin
                plugin.setSettings(pending)
                plugin.stopPreview(stopping)
            }
            assertTrue("Stop did not settle", stopped.await(10, TimeUnit.SECONDS))
            assertTrue("Pending metering did not settle", settled.await(10, TimeUnit.SECONDS))
            assertFalse("Cancelled control cannot report success", resolved)
            val expectedCodes = if (supported) setOf("CAMERA_INACTIVE", "CAMERA_CONTROL_FAILED") else setOf("EXPOSURE_UNSUPPORTED")
            assertTrue("Expected lifecycle/camera cancellation: $rejectedCode", rejectedCode in expectedCodes)
            assertEquals(1, settlements.get())
            val after = call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings").getString("exposureMode")
            assertEquals("Cancelled operation must not update settings", before, after)
            preview(scenario)
            assertEquals("continuous", call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings").getString("exposureMode"))
            CaptureProbe(cameraInfo()).use { probe ->
                awaitState("Cancelled manual exposure must not be restored") { probe.latest.get()?.get(CaptureResult.CONTROL_AE_MODE) == CaptureResult.CONTROL_AE_MODE_ON }
            }
            call(scenario, "stopPreview")
            emit("camera-sensor-cancellation.json", JSONArray().put(JSONObject()
                .put("resolved", resolved).put("rejectedCode", rejectedCode).put("settlements", settlements.get())
                .put("manualSensorSupported", supported).put("requestedMode", target).put("beforeMode", before).put("afterMode", after)
                .put("transport", "Native PluginCall replies; same-dispatch lifecycle cancellation")))
        }
    }


    @Test fun stoppingPreviewRejectsPendingFlash_withoutRetainingTorch() {
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            preview(scenario)
            val before = call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings").getString("flash")
            val supported = cameraInfo().hasFlashUnit()
            val target = "torch"
            val settled = CountDownLatch(1)
            val stopped = CountDownLatch(1)
            val settlements = AtomicInteger()
            var rejectedCode: String? = null
            var resolved = false
            val pending = object : PluginCall(null, "ElizaCamera", "pending-metering", "setSettings",
                JSObject().put("settings", JSObject().put("flash", target))) {
                override fun resolve() { resolved = true; settlements.incrementAndGet(); settled.countDown() }
                override fun reject(message: String?, code: String?, error: Exception?, data: JSObject?) {
                    rejectedCode = code; settlements.incrementAndGet(); settled.countDown()
                }
            }
            val stopping = object : PluginCall(null, "ElizaCamera", "stop-metering", "stopPreview", JSObject()) {
                override fun resolve() { stopped.countDown() }
            }
            // One UI dispatch guarantees stop runs before the completion listener.
            // Only reply transport is intercepted; CameraX and plugin lifecycle are real.
            scenario.onActivity { activity ->
                val plugin = activity.bridge.getPlugin("ElizaCamera").instance as CameraPlugin
                plugin.setSettings(pending)
                plugin.stopPreview(stopping)
            }
            assertTrue("Stop did not settle", stopped.await(10, TimeUnit.SECONDS))
            assertTrue("Pending metering did not settle", settled.await(10, TimeUnit.SECONDS))
            assertFalse("Cancelled control cannot report success", resolved)
            val expectedCodes = if (supported) setOf("CAMERA_INACTIVE", "CAMERA_CONTROL_FAILED") else setOf("FLASH_UNSUPPORTED")
            assertTrue("Expected lifecycle/camera cancellation: $rejectedCode", rejectedCode in expectedCodes)
            assertEquals(1, settlements.get())
            val after = call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings").getString("flash")
            assertEquals("Cancelled operation must not update settings", before, after)
            preview(scenario)
            assertEquals(0, cameraInfo().torchState.value)
            call(scenario, "stopPreview")
            emit("camera-flash-cancellation.json", JSONArray().put(JSONObject()
                .put("resolved", resolved).put("rejectedCode", rejectedCode).put("settlements", settlements.get())
                .put("hasFlash", supported).put("requestedFlash", target).put("beforeFlash", before).put("afterFlash", after)
                .put("transport", "Native PluginCall replies; same-dispatch lifecycle cancellation")))
        }
    }

    @Test fun stoppingPreviewRejectsPendingFocus_withoutRetainingManualMode() {
        ActivityScenario.launch(CameraTestActivity::class.java).use { scenario ->
            preview(scenario)
            val before = call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings").getString("focusMode")
            val target = "manual"
            val settled = CountDownLatch(1)
            val stopped = CountDownLatch(1)
            val settlements = AtomicInteger()
            var rejectedCode: String? = null
            var resolved = false
            val pending = object : PluginCall(null, "ElizaCamera", "pending-metering", "setSettings",
                JSObject().put("settings", JSObject().put("focusMode", target))) {
                override fun resolve() { resolved = true; settlements.incrementAndGet(); settled.countDown() }
                override fun reject(message: String?, code: String?, error: Exception?, data: JSObject?) {
                    rejectedCode = code; settlements.incrementAndGet(); settled.countDown()
                }
            }
            val stopping = object : PluginCall(null, "ElizaCamera", "stop-metering", "stopPreview", JSObject()) {
                override fun resolve() { stopped.countDown() }
            }
            // One UI dispatch guarantees stop runs before the completion listener.
            // Only reply transport is intercepted; CameraX and plugin lifecycle are real.
            scenario.onActivity { activity ->
                val plugin = activity.bridge.getPlugin("ElizaCamera").instance as CameraPlugin
                plugin.setSettings(pending)
                plugin.stopPreview(stopping)
            }
            assertTrue("Stop did not settle", stopped.await(10, TimeUnit.SECONDS))
            assertTrue("Pending metering did not settle", settled.await(10, TimeUnit.SECONDS))
            assertFalse("Cancelled control cannot report success", resolved)
            val expectedCodes = setOf("CAMERA_INACTIVE", "CAMERA_CONTROL_FAILED")
            assertTrue("Expected lifecycle/camera cancellation: $rejectedCode", rejectedCode in expectedCodes)
            assertEquals(1, settlements.get())
            val after = call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings").getString("focusMode")
            assertEquals("Cancelled operation must not update settings", before, after)
            preview(scenario)
            CaptureProbe(cameraInfo()).use { probe ->
                awaitState("Cancelled focus must not replace the restored policy") {
                    probe.latest.get()?.get(CaptureResult.CONTROL_AF_MODE) == CaptureResult.CONTROL_AF_MODE_CONTINUOUS_PICTURE
                }
            }
            call(scenario, "stopPreview")
            emit("camera-focus-cancellation.json", JSONArray().put(JSONObject()
                .put("resolved", resolved).put("rejectedCode", rejectedCode).put("settlements", settlements.get())
                .put("requestedFocus", target).put("beforeFocus", before).put("afterFocus", after)
                .put("transport", "Native PluginCall replies; same-dispatch lifecycle cancellation")))
        }
    }

}
