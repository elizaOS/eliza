package ai.eliza.plugins.system

import android.Manifest
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.graphics.Bitmap
import java.io.ByteArrayOutputStream
import java.util.concurrent.ConcurrentHashMap
import android.os.SystemClock
import android.util.Base64
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.getcapacitor.BridgeActivity
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class SystemFlashlightTestActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(SystemPlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}

/** Real WebView, permission-controller dialogs and CameraManager; no fake hardware. */
@RunWith(AndroidJUnit4::class)
class SystemFlashlightInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()

    private fun evaluate(scenario: ActivityScenario<SystemFlashlightTestActivity>, script: String): String {
        val done = CountDownLatch(1)
        var value = "null"
        scenario.onActivity { it.bridge.webView.evaluateJavascript(script) { result -> value = result; done.countDown() } }
        assertTrue("WebView evaluation timed out", done.await(10, TimeUnit.SECONDS))
        return value
    }

    private fun awaitResult(scenario: ActivityScenario<SystemFlashlightTestActivity>): JSONObject {
        val deadline = SystemClock.elapsedRealtime() + 5000
        do {
            val raw = evaluate(scenario, "JSON.stringify(window.flashlightResult ?? null)")
            val result = JSONTokener(raw).nextValue() as? String
            if (result != null && result != "null") return JSONObject(result)
            SystemClock.sleep(40)
        } while (SystemClock.elapsedRealtime() < deadline)
        screenshot("flashlight-unsettled.png")
        fail("Flashlight promise did not settle; malformed input must not open a permission dialog")
        throw AssertionError()
    }

    private fun request(scenario: ActivityScenario<SystemFlashlightTestActivity>, options: String) {
        evaluate(scenario, """
            window.flashlightResult = null;
            window.Capacitor.nativePromise('ElizaSystem', 'setFlashlight', $options).then(
              value => window.flashlightResult = {resolved:true, value},
              error => window.flashlightResult = {resolved:false, error:String(error.message ?? error)});
        """.trimIndent())
    }

    private fun screenshot(name: String) {
        val bitmap = requireNotNull(instrumentation.uiAutomation.takeScreenshot())
        val output = ByteArrayOutputStream()
        try { check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)) } finally { bitmap.recycle() }
        instrumentation.sendStatus(2, Bundle().apply {
            putString("nativeArtifactName", name)
            putString("nativeArtifactBase64", Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP))
        })
    }

    private fun clickPermission(id: String) {
        val deadline = SystemClock.elapsedRealtime() + 15000
        do {
            val root = instrumentation.uiAutomation.rootInActiveWindow
            for (pkg in listOf("com.android.permissioncontroller", "com.google.android.permissioncontroller")) {
                val button = root?.findAccessibilityNodeInfosByViewId("$pkg:id/$id")?.firstOrNull()
                if (button != null) {
                    // Let the system sheet finish animating before capturing its controls.
                    instrumentation.uiAutomation.waitForIdle(500, 5000)
                    screenshot("flashlight-$id.png")
                    if (button.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return
                }
            }
            SystemClock.sleep(50)
        } while (SystemClock.elapsedRealtime() < deadline)
        fail("Native camera permission dialog missing $id")
    }

    @Test fun flashlightValidatesBeforePermission_andVerifiesNativeDenialGrantAndTorch() {
        val context = instrumentation.targetContext
        check(Build.HARDWARE in setOf("ranchu", "goldfish")) { "Use a stock isolated emulator" }
        check(context.packageName.endsWith(".test"))
        assertNotEquals("Install the test APK without -g", PackageManager.PERMISSION_GRANTED,
            context.checkSelfPermission(Manifest.permission.CAMERA))
        val camera = context.getSystemService(CameraManager::class.java)
        val cameras = JSONArray()
        for (id in camera.cameraIdList) {
            val flash = camera.getCameraCharacteristics(id).get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
            cameras.put(JSONObject().put("id", id).put("flashAvailable", flash))
        }
        assertTrue("Camera enumeration must be real", cameras.length() > 0)
        val flashIds = camera.cameraIdList.filter {
            camera.getCameraCharacteristics(it).get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
        }
        val torchStates = ConcurrentHashMap<String, Boolean>()
        val callback = object : CameraManager.TorchCallback() {
            override fun onTorchModeChanged(cameraId: String, enabled: Boolean) { torchStates[cameraId] = enabled }
        }
        camera.registerTorchCallback(callback, Handler(Looper.getMainLooper()))
        fun awaitTorch(enabled: Boolean) {
            val deadline = SystemClock.elapsedRealtime() + 5000
            while (!flashIds.any { torchStates[it] == enabled }) {
                assertTrue("CameraManager did not observe torch=$enabled", SystemClock.elapsedRealtime() < deadline)
                SystemClock.sleep(40)
            }
        }
        if (flashIds.isNotEmpty()) {
            val deadline = SystemClock.elapsedRealtime() + 5000
            while (flashIds.any { !torchStates.containsKey(it) }) {
                assertTrue("Initial torch state unavailable", SystemClock.elapsedRealtime() < deadline)
                SystemClock.sleep(40)
            }
            assertFalse("Use an idle isolated emulator", torchStates.values.any { it })
        }
        val receipts = JSONArray()
        val automation = instrumentation.uiAutomation
        val info = automation.serviceInfo
        val originalFlags = info.flags
        info.flags = originalFlags or AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
        automation.serviceInfo = info
        try {
            ActivityScenario.launch(SystemFlashlightTestActivity::class.java).use { scenario ->
                val deadline = SystemClock.elapsedRealtime() + 15000
                while (evaluate(scenario, "Boolean(window.Capacitor?.isPluginAvailable('ElizaSystem'))") != "true") {
                    assertTrue("Capacitor initialization timed out", SystemClock.elapsedRealtime() < deadline)
                    SystemClock.sleep(50)
                }
                fun rejected(options: String, message: String): JSONObject {
                    request(scenario, options)
                    val result = awaitResult(scenario)
                    assertFalse(result.getBoolean("resolved"))
                    assertEquals(message, result.getString("error"))
                    receipts.put(JSONObject().put("options", JSONObject(options)).put("result", result))
                    return result
                }
                for (options in listOf("{}", "{\"enabled\":null}", "{\"enabled\":\"true\"}", "{\"enabled\":1}")) {
                    rejected(options, "enabled must be a boolean")
                    assertNotEquals(PackageManager.PERMISSION_GRANTED, context.checkSelfPermission(Manifest.permission.CAMERA))
                    assertFalse("Invalid input must not show a native permission prompt",
                        automation.rootInActiveWindow?.packageName?.toString()?.endsWith("permissioncontroller") == true)
                }
                screenshot("flashlight-invalid-input-no-prompt.png")
                request(scenario, "{\"enabled\":true}")
                clickPermission("permission_deny_button")
                val denied = awaitResult(scenario)
                assertFalse(denied.getBoolean("resolved"))
                assertEquals("Camera permission is required to control the flashlight", denied.getString("error"))
                receipts.put(JSONObject().put("stage", "native-denial").put("result", denied))
                assertNotEquals(PackageManager.PERMISSION_GRANTED, context.checkSelfPermission(Manifest.permission.CAMERA))
                request(scenario, "{\"enabled\":true}")
                clickPermission("permission_allow_foreground_only_button")
                val granted = awaitResult(scenario)
                assertEquals(PackageManager.PERMISSION_GRANTED, context.checkSelfPermission(Manifest.permission.CAMERA))
                if (flashIds.isEmpty()) {
                    assertFalse(granted.getBoolean("resolved"))
                    assertEquals("This device does not have an available flashlight", granted.getString("error"))
                    rejected("{\"enabled\":false}", "This device does not have an available flashlight")
                } else {
                    assertTrue(granted.getBoolean("resolved"))
                    assertTrue(granted.getJSONObject("value").getBoolean("available"))
                    assertTrue(granted.getJSONObject("value").getBoolean("enabled"))
                    awaitTorch(true)
                    receipts.put(JSONObject().put("stage", "native-torch-on").put("cameraManager", JSONObject(torchStates as Map<*, *>)))
                    request(scenario, "{\"enabled\":false}")
                    val disabled = awaitResult(scenario)
                    assertTrue(disabled.getBoolean("resolved"))
                    assertFalse(disabled.getJSONObject("value").getBoolean("enabled"))
                    val deadline = SystemClock.elapsedRealtime() + 5000
                    while (torchStates.values.any { it }) {
                        assertTrue("Torch must turn off", SystemClock.elapsedRealtime() < deadline)
                        SystemClock.sleep(40)
                    }
                    receipts.put(JSONObject().put("stage", "native-torch-off").put("result", disabled).put("cameraManager", JSONObject(torchStates as Map<*, *>)))
                }
                receipts.put(JSONObject().put("stage", "native-grant").put("result", granted))
                rejected("{\"enabled\":\"false\"}", "enabled must be a boolean")
            }
            val evidence = JSONObject().put("cameras", cameras).put("receipts", receipts)
                .put("physicalTorchVerified", false).put("permissionGrantedByNativeDialog", true)
            instrumentation.sendStatus(2, Bundle().apply {
                putString("nativeArtifactName", "flashlight-permission-contract.json")
                putString("nativeArtifactBase64", Base64.encodeToString(evidence.toString().toByteArray(), Base64.NO_WRAP))
            })
        } finally {
            try {
                for (id in flashIds) {
                    if (torchStates[id] == true) camera.setTorchMode(id, false)
                }
                val deadline = SystemClock.elapsedRealtime() + 5000
                while (torchStates.values.any { it }) {
                    assertTrue("Torch restoration failed", SystemClock.elapsedRealtime() < deadline)
                    SystemClock.sleep(40)
                }
            } finally {
                camera.unregisterTorchCallback(callback)
                info.flags = originalFlags
                automation.serviceInfo = info
            }
            // Only this disposable .test package was granted access; the runner uninstalls it.
        }
    }
}
