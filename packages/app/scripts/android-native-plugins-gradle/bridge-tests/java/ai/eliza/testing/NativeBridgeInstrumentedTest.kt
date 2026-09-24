package ai.eliza.testing

import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.view.WindowManager
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.getcapacitor.BridgeActivity
import com.getcapacitor.Plugin
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class NativeBridgeTestActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        val descriptor = JSONObject(assets.open("native-plugin.json").bufferedReader().use { it.readText() })
        registerPlugin(Class.forName(descriptor.getString("class")).asSubclass(Plugin::class.java))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setTurnScreenOn(true)
            setShowWhenLocked(true)
        }
        super.onCreate(savedInstanceState)
        @Suppress("DEPRECATION")
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or
            WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
            WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED)
    }
}

@RunWith(AndroidJUnit4::class)
class NativeBridgeInstrumentedTest {
    private fun evaluate(scenario: ActivityScenario<NativeBridgeTestActivity>, script: String): String {
        val latch = CountDownLatch(1)
        var value = "null"
        scenario.onActivity { it.bridge.webView.evaluateJavascript(script) { result -> value = result; latch.countDown() } }
        assertTrue("WebView evaluation timed out", latch.await(10, TimeUnit.SECONDS))
        return value
    }

    @Test
    fun javascriptCallsProductionPluginThroughCapacitor() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val descriptor = JSONObject(context.assets.open("native-plugin.json").bufferedReader().use { it.readText() })
        val script = context.assets.open("contracts.js").bufferedReader().use { it.readText() }
        if (InstrumentationRegistry.getArguments().getString("networkTransitions") == "1") {
            check(descriptor.getString("directory") == "plugin-native-network-policy")
            NetworkTransitionFixture(context).use { fixture ->
                var stage = 0
                fixture.run { name, expected ->
                    descriptor.put("networkStage", "${stage++}-$name")
                    descriptor.put("expectedMetered", expected)
                    runContract(descriptor, script)
                }
            }
            return
        }
        val phoneFixture = if (descriptor.getString("directory") == "plugin-native-phone") PhoneCallLogFixture(context) else null
        try {
            phoneFixture?.let { descriptor.put("phoneFixture", it.descriptor) }
            repeat(if (phoneFixture == null) 1 else 2) { attempt ->
                descriptor.put("recreated", attempt > 0)
                runContract(descriptor, script)
            }
        } finally {
            phoneFixture?.close()
        }
    }

    private fun runContract(descriptor: JSONObject, script: String) {
        ActivityScenario.launch(NativeBridgeTestActivity::class.java).use { scenario ->
            scenario.moveToState(Lifecycle.State.RESUMED)
            assertEquals("Bridge host must be foregrounded", Lifecycle.State.RESUMED, scenario.state)
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
            while (evaluate(scenario, "Boolean(window.Capacitor && window.Capacitor.nativePromise)") != "true") {
                assertTrue("Capacitor initialization timed out", System.nanoTime() < deadline)
                Thread.sleep(50)
            }
            evaluate(scenario, "window.nativeDescriptor = $descriptor; $script")
            val finishDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
            while (System.nanoTime() < finishDeadline) {
                val raw = evaluate(scenario, "window.nativeContractResult")
                if (raw != "null") {
                    val result = JSONObject(JSONTokener(raw).nextValue() as String)
                    assertFalse("Native contract failed: $result", result.has("error"))
                    assertTrue("Contract must assert native behavior", result.getInt("assertions") > 0)
                    if (descriptor.has("networkStage")) {
                        val evidence = evaluate(scenario, "JSON.stringify(window.nativeNetworkEvidence)")
                        result.put("network", JSONObject(JSONTokener(evidence).nextValue() as String))
                        result.put("stage", descriptor.getString("networkStage"))
                        InstrumentationRegistry.getInstrumentation().sendStatus(2, Bundle().apply {
                            putString("nativeArtifactName", "network-${descriptor.getString("networkStage")}.json")
                            putString("nativeArtifactBase64", Base64.encodeToString(result.toString().toByteArray(), Base64.NO_WRAP))
                        })
                    }
                    if (descriptor.has("phoneFixture")) {
                        val evidence = evaluate(scenario, "JSON.stringify(window.nativePhoneEvidence)")
                        result.put("providerResult", JSONObject(JSONTokener(evidence).nextValue() as String))
                        result.put("hostRecreated", descriptor.getBoolean("recreated"))
                        result.put("callTypes", "incoming,outgoing,missed,rejected,blocked,answered_externally")
                        result.put("transcript", "long Unicode transcript and summary read through production bridge")
                        InstrumentationRegistry.getInstrumentation().sendStatus(2, Bundle().apply {
                            putString("nativeArtifactName", "phone-round-trip-${descriptor.getBoolean("recreated")}.json")
                            putString("nativeArtifactBase64", Base64.encodeToString(result.toString().toByteArray(), Base64.NO_WRAP))
                        })
                    }
                    return
                }
                Thread.sleep(30)
            }
            fail("Native contract timed out: $descriptor")
        }
    }
}
