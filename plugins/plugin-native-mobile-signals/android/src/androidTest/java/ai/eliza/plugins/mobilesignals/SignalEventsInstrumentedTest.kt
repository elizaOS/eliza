package ai.eliza.plugins.mobilesignals

import android.content.Context
import android.content.BroadcastReceiver
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.BatteryManager
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.os.PowerManager
import android.os.SystemClock
import android.util.Base64
import android.view.WindowManager
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

class SignalEventsTestActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(MobileSignalsPlugin::class.java)
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
}

/** Actual screen state transitions reach a JavaScript listener through the production bridge. */
@RunWith(AndroidJUnit4::class)
class SignalEventsInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val power get() = instrumentation.targetContext.getSystemService(Context.POWER_SERVICE) as PowerManager

    private fun shell(command: String): String = instrumentation.uiAutomation.executeShellCommand(command).use {
        ParcelFileDescriptor.AutoCloseInputStream(it).bufferedReader().use { reader -> reader.readText() }
    }

    private fun awaitState(message: String, predicate: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 10000
        while (!predicate()) {
            assertTrue(message, SystemClock.elapsedRealtime() < deadline)
            SystemClock.sleep(50)
        }
    }

    private fun evaluate(scenario: ActivityScenario<SignalEventsTestActivity>, script: String): String {
        val done = CountDownLatch(1)
        var value = "null"
        scenario.onActivity { it.bridge.webView.evaluateJavascript(script) { result -> value = result; done.countDown() } }
        assertTrue("WebView evaluation timed out", done.await(10, TimeUnit.SECONDS))
        return value
    }

    private fun json(scenario: ActivityScenario<SignalEventsTestActivity>, expression: String): String =
        JSONTokener(evaluate(scenario, "JSON.stringify($expression)")).nextValue() as String

    private fun call(scenario: ActivityScenario<SignalEventsTestActivity>, expression: String): JSONObject {
        evaluate(scenario, """
            window.signalResult = null;
            (async () => { try { window.signalResult = {value: await ($expression)}; }
            catch(error) { window.signalResult = {error: String(error.message ?? error)}; } })();
        """.trimIndent())
        awaitState("Native promise did not settle: $expression") { evaluate(scenario, "window.signalResult !== null") == "true" }
        val result = JSONObject(json(scenario, "window.signalResult"))
        assertFalse("Native promise failed: $result", result.has("error"))
        return result
    }

    private fun events(scenario: ActivityScenario<SignalEventsTestActivity>) = JSONArray(json(scenario, "window.signalEvents"))
    private fun reason(event: JSONObject) = event.optJSONObject("metadata")?.optString("reason")
    private fun matching(events: JSONArray, action: String): List<JSONObject> = (0 until events.length())
        .map { events.getJSONObject(it) }.filter { it.optString("source") == "mobile_device" && reason(it) == "broadcast:android.intent.action.$action" }

    private fun cycleScreen() {
        val context = instrumentation.targetContext
        val offDelivered = CountDownLatch(1)
        val observer = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (intent.action == Intent.ACTION_SCREEN_OFF) offDelivered.countDown()
            }
        }
        context.registerReceiver(observer, IntentFilter(Intent.ACTION_SCREEN_OFF))
        try {
            shell("input keyevent KEYCODE_SLEEP")
            awaitState("Android did not enter non-interactive state") { !power.isInteractive }
            // Delivery can lag the PowerManager change. Wait for the actual OS
            // broadcast before waking, rather than assuming a fixed sleep is enough.
            assertTrue("Android did not deliver SCREEN_OFF", offDelivered.await(10, TimeUnit.SECONDS))
            instrumentation.waitForIdleSync()
            assertFalse("Device must remain asleep while SCREEN_OFF is delivered", power.isInteractive)
            shell("input keyevent KEYCODE_WAKEUP")
            shell("wm dismiss-keyguard")
            awaitState("Android did not return to interactive state") { power.isInteractive }
        } finally {
            context.unregisterReceiver(observer)
        }
    }

    @Test fun screenEventsCrossWebView_andRespectMonitoringAndListenerLifecycle() {
        check(Build.HARDWARE in setOf("ranchu", "goldfish")) { "Use an isolated emulator" }
        check(instrumentation.targetContext.packageName.endsWith(".test"))
        assertTrue("Runner must wake the emulator before testing", power.isInteractive)
        val evidence = JSONArray()
        try {
            ActivityScenario.launch(SignalEventsTestActivity::class.java).use { scenario ->
                awaitState("MobileSignals bridge did not register") {
                    evaluate(scenario, "Boolean(window.Capacitor?.isPluginAvailable('MobileSignals'))") == "true"
                }
                evaluate(scenario, "window.signalEvents = []")
                call(scenario, "window.Capacitor.Plugins.MobileSignals.addListener('signal', event => window.signalEvents.push(event))")
                fun native(method: String, options: String = "{}") = call(scenario,
                    "window.Capacitor.nativePromise('MobileSignals', '$method', $options)").getJSONObject("value")
                fun clear() { evaluate(scenario, "window.signalEvents = []") }
                fun record(stage: String, result: JSONObject? = null) {
                    evidence.put(JSONObject().put("stage", stage).put("events", events(scenario))
                        .put("nativeInteractive", power.isInteractive).put("receipt", result))
                }
                val start = native("startMonitoring", "{emitInitial:true}")
                assertTrue(start.getBoolean("enabled"))
                assertEquals("android", start.getString("platform"))
                awaitState("Initial device signal missing") {
                    val data = events(scenario)
                    (0 until data.length()).any { reason(data.getJSONObject(it)) == "start" && data.getJSONObject(it).getString("source") == "mobile_device" }
                }
                record("initial", start)
                native("startMonitoring", "{emitInitial:true}")
                clear()
                cycleScreen()
                awaitState("Screen broadcasts did not reach JavaScript") {
                    val data = events(scenario)
                    matching(data, "SCREEN_OFF").isNotEmpty() && matching(data, "SCREEN_ON").isNotEmpty()
                }
                val data = events(scenario)
                record("sleep-wake-observed")
                assertEquals("Duplicate start must not register another receiver", 1, matching(data, "SCREEN_OFF").size)
                assertEquals(1, matching(data, "SCREEN_ON").size)
                val off = matching(data, "SCREEN_OFF").single()
                val on = matching(data, "SCREEN_ON").single()
                assertFalse(off.getJSONObject("metadata").getBoolean("isInteractive"))
                assertTrue(off.getString("state") in setOf("locked", "background"))
                assertTrue(on.getJSONObject("metadata").getBoolean("isInteractive"))
                assertTrue(on.getLong("observedAt") >= off.getLong("observedAt"))
                record("sleep-wake-idempotent-start")
                val snapshot = native("getSnapshot")
                val device = snapshot.getJSONObject("snapshot")
                val metadata = device.getJSONObject("metadata")
                assertTrue(metadata.getBoolean("isInteractive"))
                val battery = requireNotNull(instrumentation.targetContext.registerReceiver(null,
                    IntentFilter(Intent.ACTION_BATTERY_CHANGED)))
                val level = battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
                val scale = battery.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
                assertTrue("Android battery reading must be available", level >= 0 && scale > 0)
                assertEquals(level.toDouble() / scale, metadata.getDouble("batteryLevel"), 0.000001)
                assertEquals(battery.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1) == 0, device.getBoolean("onBattery"))
                assertEquals(battery.getIntExtra(BatteryManager.EXTRA_STATUS, -1) in setOf(
                    BatteryManager.BATTERY_STATUS_CHARGING, BatteryManager.BATTERY_STATUS_FULL),
                    metadata.getBoolean("isCharging"))
                record("awake-snapshot", snapshot)
                val stop = native("stopMonitoring")
                assertTrue(stop.getBoolean("stopped"))
                clear()
                cycleScreen()
                SystemClock.sleep(750)
                assertEquals("Stop must suppress signal delivery", 0, events(scenario).length())
                record("stopped", stop)
                native("stopMonitoring")
                native("startMonitoring", "{emitInitial:false}")
                clear()
                cycleScreen()
                awaitState("Restarted monitor did not deliver screen events") {
                    matching(events(scenario), "SCREEN_ON").size == 1
                }
                assertEquals(1, matching(events(scenario), "SCREEN_OFF").size)
                record("restarted")
                call(scenario, "window.Capacitor.Plugins.MobileSignals.removeAllListeners()")
                clear()
                cycleScreen()
                SystemClock.sleep(750)
                assertEquals("Removed listener must not receive signals", 0, events(scenario).length())
                record("listeners-removed")
                native("stopMonitoring")
            }
            val result = JSONObject().put("stages", evidence).put("source", "Real Android screen broadcasts through Capacitor WebView")
                .put("restoredInteractive", power.isInteractive)
            instrumentation.sendStatus(2, Bundle().apply {
                putString("nativeArtifactName", "mobile-signal-events.json")
                putString("nativeArtifactBase64", Base64.encodeToString(result.toString().toByteArray(), Base64.NO_WRAP))
            })
        } finally {
            shell("input keyevent KEYCODE_WAKEUP")
            shell("wm dismiss-keyguard")
            awaitState("Screen restoration failed") { power.isInteractive }
        }
    }
}
