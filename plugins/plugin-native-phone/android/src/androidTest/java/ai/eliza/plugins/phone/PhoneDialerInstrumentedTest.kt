package ai.eliza.plugins.phone

import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.util.Base64
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PhoneDialerInstrumentedTest {
    private fun evaluate(scenario: ActivityScenario<PhoneTestActivity>, script: String): String {
        val done = CountDownLatch(1)
        var result = "null"
        scenario.onActivity { it.bridge.webView.evaluateJavascript(script) { value -> result = value; done.countDown() } }
        assertTrue("JavaScript evaluation timed out", done.await(5, TimeUnit.SECONDS))
        return result
    }
    private fun waitFor(scenario: ActivityScenario<PhoneTestActivity>, condition: String) {
        val deadline = SystemClock.elapsedRealtime() + 5000
        while (evaluate(scenario, "Boolean($condition)") != "true") {
            assertTrue("Timed out waiting for $condition", SystemClock.elapsedRealtime() < deadline)
            SystemClock.sleep(20)
        }
    }
    private fun call(scenario: ActivityScenario<PhoneTestActivity>, args: JSONObject): JSONObject {
        waitFor(scenario, "window.Capacitor && window.Capacitor.nativePromise")
        evaluate(scenario, "window.dialerReply=null;window.Capacitor.nativePromise('ElizaPhone','openDialer',$args).then(value=>window.dialerReply={ok:true,value:value||{}},error=>window.dialerReply={ok:false,code:error.code||null,message:error.message})")
        waitFor(scenario, "window.dialerReply !== null")
        return JSONObject(JSONTokener(evaluate(scenario, "JSON.stringify(window.dialerReply)")).nextValue() as String)
    }
    private fun receipt(name: String, data: JSONObject) {
        InstrumentationRegistry.getInstrumentation().sendStatus(2, Bundle().apply {
            putString("nativeArtifactName", name)
            putString("nativeArtifactBase64", Base64.encodeToString(data.toString().toByteArray(), Base64.NO_WRAP))
        })
    }
    private fun window(): JSONObject {
        val nodes = JSONArray()
        val root = InstrumentationRegistry.getInstrumentation().uiAutomation.rootInActiveWindow
        fun visit(node: AccessibilityNodeInfo) {
            nodes.put(JSONObject().put("text", node.text?.toString() ?: "").put("description", node.contentDescription?.toString() ?: "").put("id", node.viewIdResourceName ?: ""))
            for (index in 0 until node.childCount) node.getChild(index)?.let { child -> try { visit(child) } finally { child.recycle() } }
        }
        val result = JSONObject().put("package", root?.packageName?.toString() ?: "").put("nodes", nodes)
        root?.let { try { visit(it) } finally { it.recycle() } }
        return result
    }
    @Test fun nativeDialerReceivesTheCompleteNumberWithoutPlacingACall() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val dialerPackage = (context.getSystemService(android.content.Context.TELECOM_SERVICE) as android.telecom.TelecomManager).defaultDialerPackage
        assertNotNull("A default dialer is required for this device contract", dialerPackage)
        val expected = "+15550123456#12"
        ActivityScenario.launch(PhoneTestActivity::class.java).use { scenario ->
            val reply = call(scenario, JSONObject().put("number", "  $expected  "))
            var intents = JSONArray()
            scenario.onActivity { intents = JSONArray(it.dialerIntents.toString()) }
            val deadline = SystemClock.elapsedRealtime() + 5000
            var observed = window()
            while (observed.getString("package") != dialerPackage && SystemClock.elapsedRealtime() < deadline) {
                SystemClock.sleep(50); observed = window()
            }
            receipt("phone-native-dialer.json", JSONObject().put("expectedNumber", expected).put("dialerPackage", dialerPackage).put("reply", reply).put("intents", intents).put("window", observed))
            val screenshot = requireNotNull(InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot())
            val png = java.io.ByteArrayOutputStream()
            try { assertTrue(screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, png)) } finally { screenshot.recycle() }
            InstrumentationRegistry.getInstrumentation().sendStatus(2, Bundle().apply {
                putString("nativeArtifactName", "phone-native-dialer.png")
                putString("nativeArtifactBase64", Base64.encodeToString(png.toByteArray(), Base64.NO_WRAP))
            })
            assertTrue(reply.toString(), reply.getBoolean("ok"))
            assertEquals(1, intents.length())
            assertEquals(Intent.ACTION_DIAL, intents.getJSONObject(0).getString("action"))
            assertEquals(expected, intents.getJSONObject(0).getString("number"))
            assertTrue(intents.getJSONObject(0).isNull("fragment"))
            assertEquals(dialerPackage, observed.getString("package"))
            val nodes = observed.getJSONArray("nodes")
            assertTrue("Native dialer must display the complete number: $observed", (0 until nodes.length()).any {
                nodes.getJSONObject(it).getString("text").replace(Regex("[^0-9+#*]"), "") == expected
            })
        }
    }
    @Test fun invalidNumbersRejectBeforeLaunchingAnActivity() {
        val values = listOf<Any>(JSONObject.NULL, 123, true, JSONObject(), JSONArray())
        val results = JSONArray()
        for (value in values) ActivityScenario.launch(PhoneTestActivity::class.java).use { scenario ->
            val reply = call(scenario, JSONObject().put("number", value))
            var launches = -1
            scenario.onActivity { launches = it.dialerIntents.length() }
            results.put(JSONObject().put("input", value).put("reply", reply).put("launches", launches))
        }
        receipt("phone-dialer-invalid.json", JSONObject().put("results", results))
        for (index in 0 until results.length()) {
            val row = results.getJSONObject(index)
            assertFalse(row.toString(), row.getJSONObject("reply").getBoolean("ok"))
            assertEquals("INVALID_ARGUMENT", row.getJSONObject("reply").getString("code"))
            assertEquals(0, row.getInt("launches"))
        }
    }
    @Test fun launchFailuresReachTheRealWebViewAsRejections() {
        val results = JSONArray()
        for ((mode, code) in listOf("missing" to "DIALER_UNAVAILABLE", "denied" to "DIALER_PERMISSION_DENIED")) {
            ActivityScenario.launch(PhoneTestActivity::class.java).use { scenario ->
                scenario.onActivity { it.dialerFailure = mode }
                val reply = call(scenario, JSONObject())
                scenario.onActivity { it.dialerFailure = null }
                val recovery = call(scenario, JSONObject())
                var intents = JSONArray()
                scenario.onActivity { intents = JSONArray(it.dialerIntents.toString()) }
                results.put(JSONObject().put("mode", mode).put("expectedCode", code).put("reply", reply).put("recovery", recovery).put("intents", intents))
            }
        }
        receipt("phone-dialer-failures.json", JSONObject().put("results", results))
        for (index in 0 until results.length()) {
            val row = results.getJSONObject(index)
            assertFalse(row.getJSONObject("reply").getBoolean("ok"))
            assertEquals(row.getString("expectedCode"), row.getJSONObject("reply").getString("code"))
            assertTrue(row.getJSONObject("recovery").getBoolean("ok"))
            assertEquals(2, row.getJSONArray("intents").length())
            assertEquals("", row.getJSONArray("intents").getJSONObject(1).getString("number"))
        }
    }
}
