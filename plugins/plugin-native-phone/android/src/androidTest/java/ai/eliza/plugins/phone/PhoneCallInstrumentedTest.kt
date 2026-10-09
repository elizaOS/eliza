package ai.eliza.plugins.phone

import android.os.Bundle
import android.os.SystemClock
import android.util.Base64
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
class PhoneCallInstrumentedTest {
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
    private fun call(scenario: ActivityScenario<PhoneTestActivity>, args: JSONObject, method: String = "placeCall"): JSONObject {
        waitFor(scenario, "window.Capacitor && window.Capacitor.nativePromise")
        evaluate(scenario, "window.dialerReply=null;window.Capacitor.nativePromise('ElizaPhone',${JSONObject.quote(method)},$args).then(value=>window.dialerReply={ok:true,value:value||{}},error=>window.dialerReply={ok:false,code:error.code||null,message:error.message})")
        waitFor(scenario, "window.dialerReply !== null")
        return JSONObject(JSONTokener(evaluate(scenario, "JSON.stringify(window.dialerReply)")).nextValue() as String)
    }
    private fun receipt(name: String, data: JSONObject) {
        InstrumentationRegistry.getInstrumentation().sendStatus(2, Bundle().apply {
            putString("nativeArtifactName", name)
            putString("nativeArtifactBase64", Base64.encodeToString(data.toString().toByteArray(), Base64.NO_WRAP))
        })
    }
    @Test fun unavailableTelecomRejectsAndRestoredServiceRemainsUsable() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        assertEquals(android.content.pm.PackageManager.PERMISSION_DENIED, context.checkSelfPermission(android.Manifest.permission.CALL_PHONE))
        ActivityScenario.launch(PhoneTestActivity::class.java).use { scenario ->
            val before = call(scenario, JSONObject(), "getStatus")
            scenario.onActivity { it.hideTelecom = true }
            val unavailableStatus = call(scenario, JSONObject(), "getStatus")
            val unavailableCall = call(scenario, JSONObject().put("number", "+15550123456"))
            scenario.onActivity { it.hideTelecom = false }
            val restored = call(scenario, JSONObject(), "getStatus")
            val denied = call(scenario, JSONObject().put("number", "+15550123456"))
            receipt("phone-telecom-availability.json", JSONObject().put("before", before).put("unavailableStatus", unavailableStatus).put("unavailableCall", unavailableCall).put("restored", restored).put("denied", denied).put("fixture", "Activity returns null for Telecom only; actual CALL_PHONE remains denied"))
            assertTrue(before.getBoolean("ok"))
            assertTrue(before.getJSONObject("value").getBoolean("hasTelecom"))
            assertTrue(unavailableStatus.getBoolean("ok"))
            val status = unavailableStatus.getJSONObject("value")
            assertFalse(status.getBoolean("hasTelecom"))
            assertFalse(status.getBoolean("canPlaceCalls"))
            assertTrue(status.has("defaultDialerPackage"))
            assertTrue(status.isNull("defaultDialerPackage"))
            assertFalse(status.getBoolean("isDefaultDialer"))
            assertFalse(unavailableCall.getBoolean("ok"))
            assertEquals("TELECOM_UNAVAILABLE", unavailableCall.getString("code"))
            assertEquals(before.toString(), restored.toString())
            assertEquals("CALL_PERMISSION_DENIED", denied.getString("code"))
        }
    }

    @Test fun permissionAloneDoesNotReportCallingCapabilityWithoutTelecom() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val controlled = object : android.content.ContextWrapper(context) {
            override fun getSystemService(name: String): Any? = if (name == android.content.Context.TELECOM_SERVICE) null else super.getSystemService(name)
            override fun checkSelfPermission(permission: String): Int = if (permission == android.Manifest.permission.CALL_PHONE) android.content.pm.PackageManager.PERMISSION_GRANTED else super.checkSelfPermission(permission)
        }
        val status = PhoneStatusReader(controlled).readStatus()
        receipt("phone-telecom-capability.json", JSONObject().put("fixture", "Controlled Context reports permission granted and Telecom absent; no call dispatch")
            .put("hasTelecom", status.hasTelecom).put("canPlaceCalls", status.canPlaceCalls).put("defaultDialerPackage", status.defaultDialerPackage ?: JSONObject.NULL).put("isDefaultDialer", status.isDefaultDialer))
        assertFalse(status.hasTelecom)
        assertFalse(status.canPlaceCalls)
    }

    @Test fun invalidCallNumbersAndActualPermissionDenialRejectThroughWebView() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        assertEquals("Test must never have carrier call permission", android.content.pm.PackageManager.PERMISSION_DENIED,
            context.checkSelfPermission(android.Manifest.permission.CALL_PHONE))
        val results = JSONArray()
        ActivityScenario.launch(PhoneTestActivity::class.java).use { scenario ->
            val invalid = listOf(JSONObject(), JSONObject().put("number", ""), JSONObject().put("number", "   "),
                JSONObject().put("number", JSONObject.NULL), JSONObject().put("number", 123),
                JSONObject().put("number", true), JSONObject().put("number", JSONObject()), JSONObject().put("number", JSONArray()))
            for (args in invalid) results.put(JSONObject().put("input", args).put("reply", call(scenario, args)))
            val denied = call(scenario, JSONObject().put("number", "+15550123456"))
            val recovery = call(scenario, JSONObject())
            receipt("phone-call-denial.json", JSONObject().put("callPhonePermission", "denied").put("invalid", results).put("denied", denied).put("recovery", recovery))
            for (index in 0 until results.length()) {
                val reply = results.getJSONObject(index).getJSONObject("reply")
                assertFalse(reply.toString(), reply.getBoolean("ok"))
                assertEquals("INVALID_ARGUMENT", reply.getString("code"))
            }
            assertFalse(denied.toString(), denied.getBoolean("ok"))
            assertEquals("CALL_PERMISSION_DENIED", denied.getString("code"))
            assertFalse(recovery.getBoolean("ok"))
            assertEquals("INVALID_ARGUMENT", recovery.getString("code"))
        }
    }
}
