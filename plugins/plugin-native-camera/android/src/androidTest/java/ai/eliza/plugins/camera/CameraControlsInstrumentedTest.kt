package ai.eliza.plugins.camera

import android.Manifest
import android.annotation.SuppressLint
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
        private val callback = object : CameraCaptureCallback() {
            override fun onCaptureCompleted(captureConfigId: Int, result: CameraCaptureResult) {
                result.captureResult?.let { latest.set(it) }
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
    private fun cameraInfo() = CameraSelector.DEFAULT_BACK_CAMERA.filter(
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
                }
            } finally {
                call(scenario, "stopPreview")
                emit("camera-control-zoom.json", receipts)
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
                for ((method, options) in listOf("setZoom" to "{zoom:1}", "setFocusPoint" to "{x:0.5,y:0.5}", "setExposurePoint" to "{x:0.5,y:0.5}")) {
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

}
