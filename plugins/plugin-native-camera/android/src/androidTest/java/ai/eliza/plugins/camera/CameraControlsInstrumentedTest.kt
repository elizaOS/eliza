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
                    probe.frames.get() >= count + 3 && probe.latest.get()?.get(CaptureResult.FLASH_MODE) == (if(requestedFlash == "torch") CaptureResult.FLASH_MODE_TORCH else CaptureResult.FLASH_MODE_OFF) &&
                        kotlin.math.abs((captureZoom() ?: 0.0) - requestedZoom) < 0.03 &&
                        probe.latest.get()?.get(CaptureResult.CONTROL_AWB_MODE) == mode &&
                        (requestedEv == null || (exposureIndex != null && kotlin.math.abs(exposureIndex * step - requestedEv) <= step / 2 + 0.000001))
                }
                receipts.put(JSONObject().put("stage", stage).put("preset", preset)
                    .put("actualCamera2Mode", probe.latest.get()?.get(CaptureResult.CONTROL_AWB_MODE))
                    .put("newCaptures", probe.frames.get() - count)
                    .put("requestedFlash", requestedFlash).put("capturedFlashMode", probe.latest.get()?.get(CaptureResult.FLASH_MODE))
                    .put("requestedZoom", requestedZoom.toDouble()).put("capturedZoom", captureZoom())
                    .put("requestedEv", requestedEv ?: JSONObject.NULL)
                    .put("actualExposureIndex", probe.latest.get()?.get(CaptureResult.CONTROL_AE_EXPOSURE_COMPENSATION)))
                assertEquals(requestedZoom.toDouble(), requireNotNull(info.zoomState.value).zoomRatio.toDouble(), 0.001)
                assertEquals(requestedZoom.toDouble(), call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings").getDouble("zoom"), 0.001)
                if (requestedEv != null) {
                    val index = requireNotNull(probe.latest.get()?.get(CaptureResult.CONTROL_AE_EXPOSURE_COMPENSATION))
                    assertEquals(index * step, call(scenario, "getSettings").getJSONObject("value").getJSONObject("settings").getDouble("exposureCompensation"), 0.000001)
                }
            }
            try {
                CaptureProbe(back).use { probe ->
                    val options = JSONObject().put("whiteBalance", preset).put("zoom", requestedZoom.toDouble()).put("flash", requestedFlash)
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
                for ((method, options) in listOf("setZoom" to "{zoom:1}", "setSettings" to "{settings:{zoom:1}}", "setSettings" to "{settings:{exposureCompensation:1}}", "setSettings" to "{settings:{whiteBalance:'auto'}}", "setFocusPoint" to "{x:0.5,y:0.5}", "setExposurePoint" to "{x:0.5,y:0.5}")) {
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

}
