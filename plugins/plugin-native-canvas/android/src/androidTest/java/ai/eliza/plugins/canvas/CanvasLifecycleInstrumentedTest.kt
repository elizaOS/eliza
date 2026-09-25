package ai.eliza.plugins.canvas

import android.os.Bundle
import android.os.SystemClock
import android.util.Base64
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.getcapacitor.BridgeActivity
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

class CanvasTestActivity : BridgeActivity() {
    override fun onCreate(state: Bundle?) {
        registerPlugin(CanvasPlugin::class.java)
        super.onCreate(state)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
}

@RunWith(AndroidJUnit4::class)
class CanvasLifecycleInstrumentedTest {
    private fun evaluate(scenario: ActivityScenario<CanvasTestActivity>, script: String): String {
        val done = CountDownLatch(1)
        var result = "null"
        scenario.onActivity { it.bridge.webView.evaluateJavascript(script) { value -> result = value; done.countDown() } }
        assertTrue("JavaScript evaluation timed out", done.await(5, TimeUnit.SECONDS))
        return result
    }

    private fun waitFor(scenario: ActivityScenario<CanvasTestActivity>, condition: String) {
        val deadline = SystemClock.elapsedRealtime() + 5000
        while (evaluate(scenario, "Boolean($condition)") != "true") {
            assertTrue("Timed out waiting for $condition", SystemClock.elapsedRealtime() < deadline)
            SystemClock.sleep(20)
        }
    }

    private fun call(scenario: ActivityScenario<CanvasTestActivity>, method: String, args: JSONObject = JSONObject()): JSONObject {
        evaluate(scenario, """
            window.canvasReply = null;
            window.Capacitor.nativePromise('ElizaCanvas', ${JSONObject.quote(method)}, $args).then(
              value => window.canvasReply = {ok:true,value:value || {}},
              error => window.canvasReply = {ok:false,code:error.code || null,message:error.message}
            );
        """.trimIndent())
        waitFor(scenario, "window.canvasReply !== null")
        return JSONObject(JSONTokener(evaluate(scenario, "JSON.stringify(window.canvasReply)")).nextValue() as String)
    }

    private fun success(scenario: ActivityScenario<CanvasTestActivity>, method: String, args: JSONObject = JSONObject()): JSONObject {
        val result = call(scenario, method, args)
        assertTrue("$method failed: $result", result.getBoolean("ok"))
        return result.getJSONObject("value")
    }

    private fun receipt(name: String, value: JSONObject) {
        InstrumentationRegistry.getInstrumentation().sendStatus(2, Bundle().apply {
            putString("nativeArtifactName", name)
            putString("nativeArtifactBase64", Base64.encodeToString(value.toString().toByteArray(), Base64.NO_WRAP))
        })
    }

    private fun hierarchy(scenario: ActivityScenario<CanvasTestActivity>): JSONObject {
        var surfaces = 0
        var webViews = 0
        scenario.onActivity { activity ->
            fun visit(view: View) {
                if (view is CanvasPlugin.CanvasView) surfaces++
                if (view is WebView) webViews++
                if (view is ViewGroup) for (index in 0 until view.childCount) visit(view.getChildAt(index))
            }
            visit(activity.window.decorView)
        }
        return JSONObject().put("surfaces", surfaces).put("webViews", webViews)
    }

    private fun create(scenario: ActivityScenario<CanvasTestActivity>): String {
        waitFor(scenario, "window.Capacitor && window.Capacitor.nativePromise")
        return success(scenario, "create", JSONObject().put("size", JSONObject().put("width", 96).put("height", 64))).getString("canvasId")
    }

    @Test fun detachRemovesOwnedLayersAndWebViewAndReattachRestoresThem() {
        ActivityScenario.launch(CanvasTestActivity::class.java).use { scenario ->
            val id = create(scenario)
            val target = JSONObject().put("canvasId", id)
            val before = hierarchy(scenario)
            success(scenario, "createLayer", JSONObject().put("canvasId", id).put("layer", JSONObject().put("name", "created-before-attach")))
            success(scenario, "attach", target)
            success(scenario, "navigate", JSONObject().put("canvasId", id).put("url", "about:blank"))
            val attached = hierarchy(scenario)
            success(scenario, "attach", target)
            val attachedAgain = hierarchy(scenario)
            success(scenario, "detach", target)
            val detached = hierarchy(scenario)
            success(scenario, "attach", target)
            val restored = hierarchy(scenario)
            success(scenario, "destroy", target)
            val destroyed = hierarchy(scenario)
            receipt("canvas-attachment-lifecycle.json", JSONObject().put("before", before).put("attached", attached).put("attachedAgain", attachedAgain).put("detached", detached).put("restored", restored).put("destroyed", destroyed))
            assertEquals(2, attached.getInt("surfaces"))
            assertEquals(2, attached.getInt("webViews"))
            assertEquals(attached.toString(), attachedAgain.toString())
            assertEquals(before.toString(), detached.toString())
            assertEquals(attached.toString(), restored.toString())
            assertEquals(before.toString(), destroyed.toString())
        }
    }

    @Test fun enabledTouchReachesJavaScriptAndDisabledTouchReachesHost() {
        ActivityScenario.launch(CanvasTestActivity::class.java).use { scenario ->
            val id = create(scenario)
            val target = JSONObject().put("canvasId", id)
            success(scenario, "attach", target)
            success(scenario, "createLayer", JSONObject().put("canvasId", id).put("layer", JSONObject().put("name", "touch-overlay")))
            evaluate(scenario, "window.canvasTouches=[];window.hostTouches=0;window.canvasTouchListener=window.Capacitor.addListener('ElizaCanvas','touch',e=>window.canvasTouches.push(e));document.addEventListener('touchstart',()=>window.hostTouches++);")
            val position = IntArray(2)
            scenario.onActivity { it.bridge.webView.getLocationOnScreen(position) }
            fun tap() {
                val start = SystemClock.uptimeMillis()
                val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
                for (action in listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
                    val event = MotionEvent.obtain(start, SystemClock.uptimeMillis(), action, position[0] + 20f, position[1] + 40f, 0)
                    event.source = InputDevice.SOURCE_TOUCHSCREEN
                    try { assertTrue("Touch injection failed", automation.injectInputEvent(event, true)) } finally { event.recycle() }
                    SystemClock.sleep(30)
                }
                InstrumentationRegistry.getInstrumentation().waitForIdleSync()
                SystemClock.sleep(100)
            }
            success(scenario, "setTouchEnabled", JSONObject().put("canvasId", id).put("enabled", true))
            tap()
            val enabled = JSONObject(JSONTokener(evaluate(scenario, "JSON.stringify({events:window.canvasTouches,host:window.hostTouches})")).nextValue() as String)
            evaluate(scenario, "window.canvasTouches=[];window.hostTouches=0")
            success(scenario, "setTouchEnabled", JSONObject().put("canvasId", id).put("enabled", false))
            tap()
            val disabled = JSONObject(JSONTokener(evaluate(scenario, "JSON.stringify({events:window.canvasTouches,host:window.hostTouches})")).nextValue() as String)
            evaluate(scenario, "window.canvasTouchListener.remove()")
            success(scenario, "destroy", target)
            receipt("canvas-touch-delivery.json", JSONObject().put("enabled", enabled).put("disabled", disabled))
            val events = enabled.getJSONArray("events")
            assertTrue("Enabled native canvas must receive actual injected touch", events.length() >= 2)
            assertEquals("start", events.getJSONObject(0).getString("type"))
            assertEquals("end", events.getJSONObject(events.length()-1).getString("type"))
            assertEquals(0, enabled.getInt("host"))
            assertEquals(0, disabled.getJSONArray("events").length())
            assertTrue("Disabled canvas must not intercept host touch", disabled.getInt("host") > 0)
        }
    }

    @Test fun nativeLayerOrderRemainsVisibleAcrossTouchAndAttachmentChanges() {
        ActivityScenario.launch(CanvasTestActivity::class.java).use { scenario ->
            val id = create(scenario)
            val target = JSONObject().put("canvasId", id)
            val first = success(scenario, "createLayer", JSONObject().put("canvasId", id).put("layer", JSONObject().put("name", "green").put("zIndex", 1))).getString("layerId")
            val second = success(scenario, "createLayer", JSONObject().put("canvasId", id).put("layer", JSONObject().put("name", "blue").put("zIndex", 2))).getString("layerId")
            for ((layerId, color) in listOf(first to "#00ff00", second to "#0000ff")) {
                success(scenario, "drawRect", JSONObject().put("canvasId", id).put("rect", JSONObject().put("x", 0).put("y", 0).put("width", 96).put("height", 64)).put("fill", JSONObject().put("color", color)).put("drawOptions", JSONObject().put("layerId", layerId)))
            }
            success(scenario, "attach", target)
            success(scenario, "setTouchEnabled", JSONObject().put("canvasId", id).put("enabled", true))
            val samples = JSONObject()
            fun sample(name: String, expected: Int): Int {
                val ready = CountDownLatch(1)
                val origin = IntArray(2)
                scenario.onActivity { activity ->
                    activity.bridge.webView.getLocationOnScreen(origin)
                    activity.window.decorView.postOnAnimation { activity.window.decorView.postOnAnimation { ready.countDown() } }
                }
                assertTrue("Native draw did not complete", ready.await(3, TimeUnit.SECONDS))
                val observed = JSONArray()
                var pixel = 0
                val deadline = SystemClock.elapsedRealtime() + 3000
                do {
                    val bitmap = checkNotNull(InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot())
                    pixel = try { bitmap.getPixel(origin[0] + 40, origin[1] + 40) } finally { bitmap.recycle() }
                    observed.put(pixel)
                    if (pixel == expected) break
                    SystemClock.sleep(20)
                } while (SystemClock.elapsedRealtime() < deadline)
                samples.put(name, JSONObject().put("expected", expected).put("observed", observed).put("final", pixel))
                return pixel
            }
            val original = sample("blue-on-top", android.graphics.Color.BLUE)
            success(scenario, "updateLayer", JSONObject().put("canvasId", id).put("layerId", first).put("layer", JSONObject().put("zIndex", 3)))
            val reordered = sample("green-on-top", android.graphics.Color.GREEN)
            success(scenario, "detach", target)
            success(scenario, "attach", target)
            val reattached = sample("green-after-reattach", android.graphics.Color.GREEN)
            success(scenario, "setTouchEnabled", JSONObject().put("canvasId", id).put("enabled", false))
            success(scenario, "setTouchEnabled", JSONObject().put("canvasId", id).put("enabled", true))
            val restored = sample("green-after-touch-toggle", android.graphics.Color.GREEN)
            success(scenario, "destroy", target)
            receipt("canvas-native-layer-order.json", samples)
            assertEquals(android.graphics.Color.BLUE, original)
            assertEquals(android.graphics.Color.GREEN, reordered)
            assertEquals(android.graphics.Color.GREEN, reattached)
            assertEquals(android.graphics.Color.GREEN, restored)
        }
    }

    @Test fun disablingDetachingOrDestroyingCancelsAnActiveGestureExactlyOnce() {
        val results = JSONArray()
        for (operation in listOf("disable", "detach", "destroy", "delete-layer", "hide-layer")) {
            ActivityScenario.launch(CanvasTestActivity::class.java).use { scenario ->
                val id = create(scenario)
                val target = JSONObject().put("canvasId", id)
                val layerId = if (operation.endsWith("layer")) success(scenario, "createLayer", JSONObject().put("canvasId", id).put("layer", JSONObject().put("name", "gesture-layer"))).getString("layerId") else null
                success(scenario, "attach", target)
                success(scenario, "setTouchEnabled", JSONObject().put("canvasId", id).put("enabled", true))
                evaluate(scenario, "window.gestureEvents=[];window.gestureListener=window.Capacitor.addListener('ElizaCanvas','touch',event=>window.gestureEvents.push(event))")
                val origin = IntArray(2)
                scenario.onActivity { it.bridge.webView.getLocationOnScreen(origin) }
                val downTime = SystemClock.uptimeMillis()
                fun inject(action: Int) {
                    val event = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, origin[0]+20f, origin[1]+40f, 0)
                    event.source = InputDevice.SOURCE_TOUCHSCREEN
                    try { assertTrue(InstrumentationRegistry.getInstrumentation().uiAutomation.injectInputEvent(event, true)) } finally { event.recycle() }
                }
                inject(MotionEvent.ACTION_DOWN)
                try {
                    waitFor(scenario, "window.gestureEvents.length > 0")
                    when (operation) {
                        "disable" -> success(scenario, "setTouchEnabled", JSONObject().put("canvasId", id).put("enabled", false))
                        "delete-layer" -> success(scenario, "deleteLayer", JSONObject().put("canvasId", id).put("layerId", layerId))
                        "hide-layer" -> success(scenario, "updateLayer", JSONObject().put("canvasId", id).put("layerId", layerId).put("layer", JSONObject().put("visible", false)))
                        else -> success(scenario, operation, target)
                    }
                    InstrumentationRegistry.getInstrumentation().waitForIdleSync()
                } finally { inject(MotionEvent.ACTION_UP) }
                SystemClock.sleep(100)
                val events = JSONArray(JSONTokener(evaluate(scenario, "JSON.stringify(window.gestureEvents)")).nextValue() as String)
                results.put(JSONObject().put("operation", operation).put("events", events))
                evaluate(scenario, "window.gestureListener.remove()")
                if (operation != "destroy") success(scenario, "destroy", target)
            }
        }
        receipt("canvas-gesture-cancellation.json", JSONObject().put("cases", results))
        for (index in 0 until results.length()) {
            val entry = results.getJSONObject(index)
            val events = entry.getJSONArray("events")
            assertEquals("${entry.getString("operation")} must emit exactly start/cancel", 2, events.length())
            assertEquals("start", events.getJSONObject(0).getString("type"))
            assertEquals("cancel", events.getJSONObject(1).getString("type"))
            val last = events.getJSONObject(1).getJSONArray("touches").getJSONObject(0)
            assertEquals(20.0, last.getDouble("x"), 0.01)
            assertEquals(40.0, last.getDouble("y"), 0.01)
        }
    }

    @Test fun malformedTouchSettingsRejectAndRepeatedEnablePreservesGesture() {
        ActivityScenario.launch(CanvasTestActivity::class.java).use { scenario ->
            val id = create(scenario)
            val target = JSONObject().put("canvasId", id)
            success(scenario, "attach", target)
            success(scenario, "setTouchEnabled", JSONObject().put("canvasId", id).put("enabled", true))
            evaluate(scenario, "window.gestureEvents=[];window.gestureListener=window.Capacitor.addListener('ElizaCanvas','touch',event=>window.gestureEvents.push(event))")
            val origin = IntArray(2)
            scenario.onActivity { it.bridge.webView.getLocationOnScreen(origin) }
            val downTime = SystemClock.uptimeMillis()
            fun inject(action: Int) {
                val event=MotionEvent.obtain(downTime,SystemClock.uptimeMillis(),action,origin[0]+20f,origin[1]+40f,0)
                event.source=InputDevice.SOURCE_TOUCHSCREEN
                try { assertTrue(InstrumentationRegistry.getInstrumentation().uiAutomation.injectInputEvent(event,true)) } finally {event.recycle()}
            }
            val invalid=JSONArray()
            inject(MotionEvent.ACTION_DOWN)
            try {
                waitFor(scenario,"window.gestureEvents.length > 0")
                for (value in listOf<Any?>(null,JSONObject.NULL,"true",1,JSONObject(),JSONArray())) {
                    val args=JSONObject().put("canvasId",id)
                    if(value!=null) args.put("enabled",value)
                    invalid.put(JSONObject().put("args",args).put("reply",call(scenario,"setTouchEnabled",args)))
                }
                success(scenario,"setTouchEnabled",JSONObject().put("canvasId",id).put("enabled",true))
                success(scenario,"attach",target)
            } finally {inject(MotionEvent.ACTION_UP)}
            SystemClock.sleep(100)
            val events=JSONArray(JSONTokener(evaluate(scenario,"JSON.stringify(window.gestureEvents)")).nextValue() as String)
            receipt("canvas-touch-setting-validation.json",JSONObject().put("invalid",invalid).put("events",events))
            evaluate(scenario,"window.gestureListener.remove()")
            success(scenario,"destroy",target)
            for(index in 0 until invalid.length()) {
                val reply=invalid.getJSONObject(index).getJSONObject("reply")
                assertFalse(reply.toString(),reply.getBoolean("ok"))
                assertEquals("INVALID_ARGUMENT",reply.getString("code"))
            }
            assertEquals(2,events.length())
            assertEquals("start",events.getJSONObject(0).getString("type"))
            assertEquals("end",events.getJSONObject(1).getString("type"))
        }
    }

    @Test fun popupBackDismissalRejectsFurtherUseAndCanNavigateAgain() {
        ActivityScenario.launch(CanvasTestActivity::class.java).use { scenario ->
            waitFor(scenario, "window.Capacitor && window.Capacitor.nativePromise")
            success(scenario, "navigate", JSONObject().put("url", "about:blank").put("placement", "popup"))
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            val dismissed = call(scenario, "snapshot")
            success(scenario, "navigate", JSONObject().put("url", "about:blank").put("placement", "inline"))
            val recovered = success(scenario, "eval", JSONObject().put("script", "6*7"))
            receipt("canvas-popup-dismissal.json", JSONObject().put("dismissed", dismissed).put("recovered", recovered))
            assertFalse(dismissed.getBoolean("ok"))
            assertEquals("WEBVIEW_NOT_READY", dismissed.getString("code"))
            assertEquals("42", recovered.getString("result"))
        }
    }
}
