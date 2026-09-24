package ai.eliza.testing

import android.os.Bundle
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
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
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
        val descriptor = context.assets.open("native-plugin.json").bufferedReader().use { it.readText() }
        val script = context.assets.open("contracts.js").bufferedReader().use { it.readText() }
        ActivityScenario.launch(NativeBridgeTestActivity::class.java).use { scenario ->
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
                    return
                }
                Thread.sleep(30)
            }
            fail("Native contract timed out: $descriptor")
        }
    }
}
