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
    var captureNativeTouches = false
    val nativeTouchSamples = JSONArray()
    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (captureNativeTouches) {
            val pointers = JSONArray()
            for (index in 0 until event.pointerCount) pointers.put(JSONObject()
                .put("id", event.getPointerId(index))
                .put("rawX", event.getX(index) + event.rawX - event.x)
                .put("rawY", event.getY(index) + event.rawY - event.y)
                .put("force", event.getPressure(index)))
            nativeTouchSamples.put(JSONObject().put("action", event.actionMasked).put("pointers", pointers))
        }
        return super.dispatchTouchEvent(event)
    }
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

    @Test fun multiplePointersKeepIdentityAndCancelOnlyTheRemainingFinger() {
        ActivityScenario.launch(CanvasTestActivity::class.java).use { scenario ->
            val id = create(scenario)
            val target = JSONObject().put("canvasId", id)
            success(scenario, "attach", target)
            success(scenario, "setTouchEnabled", JSONObject().put("canvasId", id).put("enabled", true))
            evaluate(scenario, "window.multiEvents=[];window.multiListener=window.Capacitor.addListener('ElizaCanvas','touch',event=>window.multiEvents.push(event))")
            val origin=IntArray(2)
            scenario.onActivity {it.bridge.webView.getLocationOnScreen(origin);it.captureNativeTouches=true}
            val downTime=SystemClock.uptimeMillis()
            data class Finger(val id: Int,val x: Float,val y: Float,val force: Float)
            var physical=listOf(Finger(3,20f,40f,0.4f))
            fun inject(action: Int, fingers: List<Finger>) {
                val properties=fingers.map {finger->MotionEvent.PointerProperties().apply {this.id=finger.id;toolType=MotionEvent.TOOL_TYPE_FINGER}}.toTypedArray()
                val coordinates=fingers.map {finger->MotionEvent.PointerCoords().apply {x=origin[0]+finger.x;y=origin[1]+finger.y;pressure=finger.force;size=0.1f}}.toTypedArray()
                val event=MotionEvent.obtain(downTime,SystemClock.uptimeMillis(),action,fingers.size,properties,coordinates,0,0,1f,1f,0,0,InputDevice.SOURCE_TOUCHSCREEN,0)
                try {assertTrue("Multi-pointer injection failed",InstrumentationRegistry.getInstrumentation().uiAutomation.injectInputEvent(event,true))} finally {event.recycle()}
            }
            inject(MotionEvent.ACTION_DOWN,physical)
            try {
                waitFor(scenario,"window.multiEvents.length >= 1")
                physical=listOf(Finger(3,20f,40f,0.4f),Finger(7,60f,50f,0.8f))
                inject(MotionEvent.ACTION_POINTER_DOWN or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT),physical)
                waitFor(scenario,"window.multiEvents.length >= 2")
                physical=listOf(Finger(3,25f,42f,0.4f),Finger(7,65f,52f,0.8f))
                inject(MotionEvent.ACTION_MOVE,physical)
                waitFor(scenario,"window.multiEvents.length >= 3")
                inject(MotionEvent.ACTION_POINTER_UP,physical)
                physical=listOf(Finger(7,65f,52f,0.8f))
                waitFor(scenario,"window.multiEvents.length >= 4")
                physical=listOf(Finger(7,70f,55f,0.8f))
                inject(MotionEvent.ACTION_MOVE,physical)
                waitFor(scenario,"window.multiEvents.length >= 5")
                success(scenario,"setTouchEnabled",JSONObject().put("canvasId",id).put("enabled",false))
                waitFor(scenario,"window.multiEvents.length >= 6")
            } finally {inject(MotionEvent.ACTION_CANCEL,physical)}
            SystemClock.sleep(100)
            val events=JSONArray(JSONTokener(evaluate(scenario,"JSON.stringify(window.multiEvents)")).nextValue() as String)
            var nativeSamples=JSONArray()
            scenario.onActivity {nativeSamples=JSONArray(it.nativeTouchSamples.toString());it.captureNativeTouches=false}
            receipt("canvas-multitouch.json",JSONObject().put("events",events).put("nativeSamples",nativeSamples).put("viewOrigin",JSONArray().put(origin[0]).put(origin[1])).put("injectedPointerIds",JSONArray().put(3).put(7)))
            evaluate(scenario,"window.multiListener.remove()")
            success(scenario,"destroy",target)
            assertEquals(6,events.length())
            val types=listOf("start","start","move","end","move","cancel")
            for(index in types.indices) assertEquals(types[index],events.getJSONObject(index).getString("type"))
            val initial=events.getJSONObject(0).getJSONArray("touches")
            assertEquals(1,initial.length())
            assertEquals(3,initial.getJSONObject(0).getInt("id"))
            val moved=events.getJSONObject(2).getJSONArray("touches")
            assertEquals(2,moved.length())
            assertEquals(3,moved.getJSONObject(0).getInt("id"))
            assertEquals(7,moved.getJSONObject(1).getInt("id"))
            val nativeMoves=(0 until nativeSamples.length()).map {nativeSamples.getJSONObject(it)}.filter {it.getInt("action")==MotionEvent.ACTION_MOVE}
            assertEquals(2,nativeMoves.size)
            for(index in 0..1) {
                val received=nativeMoves[0].getJSONArray("pointers").getJSONObject(index)
                assertEquals(received.getInt("id"),moved.getJSONObject(index).getInt("id"))
                assertEquals(received.getDouble("rawX")-origin[0],moved.getJSONObject(index).getDouble("x"),0.01)
                assertEquals(received.getDouble("rawY")-origin[1],moved.getJSONObject(index).getDouble("y"),0.01)
            }
            val cancelled=events.getJSONObject(5).getJSONArray("touches")
            assertEquals("Only the still-active pointer is cancelled",1,cancelled.length())
            assertEquals(7,cancelled.getJSONObject(0).getInt("id"))
            val finalNative=nativeMoves.last().getJSONArray("pointers").getJSONObject(0)
            val finalMove=events.getJSONObject(4).getJSONArray("touches").getJSONObject(0)
            assertEquals(finalNative.getDouble("rawX")-origin[0],finalMove.getDouble("x"),0.01)
            assertEquals(finalNative.getDouble("rawY")-origin[1],finalMove.getDouble("y"),0.01)
            assertEquals(finalMove.getDouble("x"),cancelled.getJSONObject(0).getDouble("x"),0.01)
            assertEquals(finalMove.getDouble("y"),cancelled.getJSONObject(0).getDouble("y"),0.01)
            assertEquals(0.8,cancelled.getJSONObject(0).getDouble("force"),0.01)
        }
    }

    @Test fun twoCanvasesKeepSeparateViewsAndPixelsDuringInterleavedCleanup() {
        ActivityScenario.launch(CanvasTestActivity::class.java).use { scenario ->
            val first=create(scenario)
            val second=create(scenario)
            val firstTarget=JSONObject().put("canvasId",first)
            val secondTarget=JSONObject().put("canvasId",second)
            try {
                for((id,color) in listOf(first to "#00ff00",second to "#0000ff")) {
                    val layerId=success(scenario,"createLayer",JSONObject().put("canvasId",id).put("layer",JSONObject().put("name",id))).getString("layerId")
                    success(scenario,"drawRect",JSONObject().put("canvasId",id).put("rect",JSONObject().put("x",0).put("y",0).put("width",96).put("height",64)).put("fill",JSONObject().put("color",color)).put("drawOptions",JSONObject().put("layerId",layerId)))
                    success(scenario,"attach",JSONObject().put("canvasId",id))
                    success(scenario,"navigate",JSONObject().put("canvasId",id).put("url","about:blank"))
                }
                val firstBefore=success(scenario,"toImage",firstTarget)
                val secondBefore=success(scenario,"toImage",secondTarget)
                val attached=hierarchy(scenario)
                success(scenario,"detach",firstTarget)
                val firstDetached=hierarchy(scenario)
                val secondAfterDetach=success(scenario,"toImage",secondTarget)
                success(scenario,"attach",firstTarget)
                success(scenario,"destroy",secondTarget)
                val secondDestroyed=hierarchy(scenario)
                val firstAfterDestroy=success(scenario,"toImage",firstTarget)
                success(scenario,"destroy",firstTarget)
                val cleared=hierarchy(scenario)
                val missingFirst=call(scenario,"getPixelData",firstTarget)
                val missingSecond=call(scenario,"getPixelData",secondTarget)
                receipt("canvas-multiple-owners.json",JSONObject().put("first",first).put("second",second).put("attached",attached).put("firstDetached",firstDetached).put("secondDestroyed",secondDestroyed).put("cleared",cleared).put("firstBefore",firstBefore).put("firstAfterDestroy",firstAfterDestroy).put("secondBefore",secondBefore).put("secondAfterDetach",secondAfterDetach).put("missingFirst",missingFirst).put("missingSecond",missingSecond))
                assertEquals(4,attached.getInt("surfaces"))
                assertEquals(3,attached.getInt("webViews"))
                for(state in listOf(firstDetached,secondDestroyed)) {
                    assertEquals(2,state.getInt("surfaces"))
                    assertEquals(2,state.getInt("webViews"))
                }
                assertEquals(0,cleared.getInt("surfaces"))
                assertEquals(1,cleared.getInt("webViews"))
                assertNotEquals(firstBefore.getString("base64"),secondBefore.getString("base64"))
                assertEquals(firstBefore.getString("base64"),firstAfterDestroy.getString("base64"))
                assertEquals(secondBefore.getString("base64"),secondAfterDetach.getString("base64"))
                assertFalse(missingFirst.getBoolean("ok"))
                assertFalse(missingSecond.getBoolean("ok"))
            } finally {
                success(scenario,"destroy",firstTarget)
                success(scenario,"destroy",secondTarget)
            }
        }
    }

    @Test fun invalidSizesRejectWithoutChangingPixelsAndValidResizeRecovers() {
        ActivityScenario.launch(CanvasTestActivity::class.java).use { scenario ->
            val id = create(scenario)
            val target = JSONObject().put("canvasId", id)
            success(scenario, "drawRect", JSONObject().put("canvasId", id)
                .put("rect", JSONObject().put("x", 0).put("y", 0).put("width", 96).put("height", 64))
                .put("fill", JSONObject().put("color", "#00ff00")))
            val layerId = success(scenario, "createLayer", JSONObject().put("canvasId", id).put("layer", JSONObject().put("name", "resize-layer"))).getString("layerId")
            success(scenario, "drawRect", JSONObject().put("canvasId", id)
                .put("rect", JSONObject().put("x", 0).put("y", 0).put("width", 96).put("height", 64))
                .put("fill", JSONObject().put("color", "#0000ff"))
                .put("drawOptions", JSONObject().put("layerId", layerId)))
            val layerTarget = JSONObject().put("canvasId", id).put("layerIds", JSONArray().put(layerId))
            val layerBefore = success(scenario, "toImage", layerTarget)
            val before = success(scenario, "getPixelData", target)
            val results = JSONArray()
            val invalid = listOf<Any>(
                JSONObject().put("width", 0).put("height", 64),
                JSONObject().put("width", -1).put("height", 64),
                JSONObject().put("width", 96).put("height", 0),
                JSONObject().put("width", 96).put("height", -1),
                JSONObject().put("width", 1.5).put("height", 64),
                JSONObject().put("width", 96).put("height", 2.5),
                JSONObject().put("width", "96").put("height", 64),
                JSONObject().put("width", 96).put("height", true),
                JSONObject().put("width", JSONObject.NULL).put("height", 64),
                JSONObject().put("width", 96), JSONObject(),
                JSONObject().put("width", 2147483648L).put("height", 1),
                JSONObject().put("width", 32768).put("height", 32768),
                JSONObject.NULL, JSONArray(), "size")
            for ((index, size) in invalid.withIndex()) {
                for (method in listOf("create", "resize")) {
                    receipt("canvas-size-request-$index-$method.json", JSONObject().put("method", method).put("size", size))
                    val args = JSONObject().put("size", size)
                    if (method == "resize") args.put("canvasId", id)
                    val result = call(scenario, method, args)
                    results.put(JSONObject().put("method", method).put("size", size).put("result", result))
                    if (method == "create" && result.getBoolean("ok")) {
                        success(scenario, "destroy", JSONObject().put("canvasId", result.getJSONObject("value").getString("canvasId")))
                    }
                }
            }
            val after = success(scenario, "getPixelData", target)
            val layerAfter = success(scenario, "toImage", layerTarget)
            success(scenario, "attach", target)
            success(scenario, "navigate", JSONObject().put("canvasId", id).put("url", "about:blank"))
            success(scenario, "resize", JSONObject().put("canvasId", id).put("size", JSONObject().put("width", 120).put("height", 80)))
            val grown = success(scenario, "getPixelData", target)
            val layerGrown = success(scenario, "toImage", layerTarget)
            success(scenario, "resize", JSONObject().put("canvasId", id).put("size", JSONObject().put("width", 1).put("height", 1)))
            val shrunk = success(scenario, "getPixelData", target)
            receipt("canvas-size-validation.json", JSONObject().put("results", results).put("before", before).put("after", after).put("grown", grown).put("shrunk", shrunk).put("layerBefore", layerBefore).put("layerAfter", layerAfter).put("layerGrown", layerGrown))
            for (index in 0 until results.length()) {
                val result = results.getJSONObject(index).getJSONObject("result")
                assertFalse(results.getJSONObject(index).toString(), result.getBoolean("ok"))
                assertEquals("INVALID_ARGUMENT", result.getString("code"))
            }
            assertEquals(before.toString(), after.toString())
            assertEquals(layerBefore.toString(), layerAfter.toString())
            assertEquals(120, grown.getInt("width"))
            assertEquals(80, grown.getInt("height"))
            val pixels = Base64.decode(grown.getString("data"), Base64.DEFAULT)
            val encoded = Base64.decode(layerGrown.getString("base64"), Base64.DEFAULT)
            val layerBitmap = android.graphics.BitmapFactory.decodeByteArray(encoded, 0, encoded.size)
            try {
                assertEquals(120, layerBitmap.width)
                assertEquals(80, layerBitmap.height)
                for (y in 0 until 80) for (x in 0 until 120) {
                    val inside = x < 96 && y < 64
                    val offset = (y * 120 + x) * 4
                    assertEquals(0, pixels[offset].toInt())
                    assertEquals(if (inside) 255 else 0, pixels[offset + 1].toInt() and 255)
                    assertEquals(0, pixels[offset + 2].toInt())
                    assertEquals(if (inside) 255 else 0, pixels[offset + 3].toInt() and 255)
                    assertEquals(if (inside) android.graphics.Color.BLUE else android.graphics.Color.TRANSPARENT, layerBitmap.getPixel(x, y))
                }
            } finally { layerBitmap.recycle() }
            assertEquals(1, shrunk.getInt("width"))
            assertEquals(1, shrunk.getInt("height"))
            assertArrayEquals(byteArrayOf(0, -1, 0, -1), Base64.decode(shrunk.getString("data"), Base64.DEFAULT))
            success(scenario, "destroy", target)
        }
    }

    @Test fun activityRecreationReleasesOwnedViewsAndStartsAFreshBridge() {
        val observations = JSONArray()
        for (placement in listOf("inline", "fullscreen", "popup")) {
            ActivityScenario.launch(CanvasTestActivity::class.java).use { scenario ->
                val id = create(scenario)
                val target = JSONObject().put("canvasId", id)
                success(scenario, "createLayer", JSONObject().put("canvasId", id).put("layer", JSONObject().put("name", "old-owner")))
                success(scenario, "attach", target)
                success(scenario, "navigate", JSONObject().put("canvasId", id).put("url", "about:blank"))
                success(scenario, "navigate", JSONObject().put("url", "about:blank").put("placement", placement))
                success(scenario, "eval", JSONObject().put("script", "document.body.textContent='before recreation'; 42"))
                val before = hierarchy(scenario)
                var previousActivity: CanvasTestActivity? = null
                val previousOwnedViews = mutableListOf<View>()
                scenario.onActivity { activity ->
                    previousActivity = activity
                    fun visit(view: View) {
                        if (view is CanvasPlugin.CanvasView || (view is WebView && view !== activity.bridge.webView)) previousOwnedViews.add(view)
                        if (view is ViewGroup) for (index in 0 until view.childCount) visit(view.getChildAt(index))
                    }
                    visit(activity.window.decorView)
                }
                scenario.recreate()
                waitFor(scenario, "window.Capacitor && window.Capacitor.nativePromise")
                var replaced = false
                var detached = false
                scenario.onActivity { activity ->
                    replaced = activity !== previousActivity && previousActivity!!.isDestroyed
                    detached = previousOwnedViews.all { it.parent == null }
                }
                val recreated = hierarchy(scenario)
                val staleCanvas = call(scenario, "getPixelData", target)
                val staleWeb = call(scenario, "eval", JSONObject().put("script", "42"))
                val replacement = create(scenario)
                val replacementTarget = JSONObject().put("canvasId", replacement)
                success(scenario, "attach", replacementTarget)
                success(scenario, "drawRect", JSONObject().put("canvasId", replacement)
                    .put("rect", JSONObject().put("x", 0).put("y", 0).put("width", 96).put("height", 64))
                    .put("fill", JSONObject().put("color", "#00ff00")))
                val pixels = success(scenario, "getPixelData", replacementTarget)
                success(scenario, "navigate", JSONObject().put("url", "about:blank").put("placement", placement))
                val evaluated = success(scenario, "eval", JSONObject().put("script", "6 * 7"))
                success(scenario, "destroy", replacementTarget)
                val observation = JSONObject().put("placement", placement).put("before", before).put("recreated", recreated)
                    .put("oldActivityDestroyedAndReplaced", replaced).put("oldOwnedViewCount", previousOwnedViews.size).put("oldOwnedViewsDetached", detached)
                    .put("staleCanvas", staleCanvas).put("staleWeb", staleWeb).put("replacementPixels", pixels).put("replacementEval", evaluated)
                observations.put(observation)
                receipt("canvas-recreation-$placement.json", observation)
                assertTrue(replaced)
                assertTrue(detached)
                assertEquals(2, before.getInt("surfaces"))
                assertEquals(if (placement == "popup") 3 else 4, previousOwnedViews.size)
                assertEquals(0, recreated.getInt("surfaces"))
                assertEquals(1, recreated.getInt("webViews"))
                assertFalse(staleCanvas.getBoolean("ok"))
                assertFalse(staleWeb.getBoolean("ok"))
                assertEquals("WEBVIEW_NOT_READY", staleWeb.getString("code"))
                val bytes = Base64.decode(pixels.getString("data"), Base64.DEFAULT)
                for (offset in bytes.indices step 4) assertArrayEquals(byteArrayOf(0, -1, 0, -1), bytes.copyOfRange(offset, offset + 4))
                assertEquals("42", evaluated.getString("result"))
            }
        }
        receipt("canvas-recreation.json", JSONObject().put("placements", observations))
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
