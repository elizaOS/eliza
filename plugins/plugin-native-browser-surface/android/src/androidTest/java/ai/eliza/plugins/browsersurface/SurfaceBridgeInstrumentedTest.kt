/**
 * Drives the plugin through a real Capacitor bridge, as the host page would, and loads
 * pages from a local server: the state each `navigationChanged` carries, the check that
 * lets a surface id be created again, where the below-host input router goes, and what a
 * paused page does with its dialogs and with taps.
 */
package ai.eliza.plugins.browsersurface

import android.os.Bundle
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.getcapacitor.BridgeActivity
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.MessageHandler
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginResult
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SurfaceBridgeInstrumentedTest {
    class Host : BridgeActivity() {
        override fun onCreate(savedInstanceState: Bundle?) {
            registerPlugin(ElizaSurfaceManagerPlugin::class.java)
            super.onCreate(savedInstanceState)
        }
    }

    /** Records what the plugin sends back to the host page, by callback id. */
    private class Replies(host: Host) : MessageHandler(host.bridge, host.bridge.webView, null) {
        val results = LinkedBlockingQueue<Pair<String, JSONObject>>()

        override fun sendResponseMessage(call: PluginCall, successResult: PluginResult?, errorResult: PluginResult?) {
            val reply = errorResult?.let { JSONObject().put("error", it.toString()) }
                ?: JSONObject(successResult?.toString() ?: "{}")
            results.put(call.callbackId to reply)
        }
    }

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val identity = JSObject().put("owner", "bridge-test").put("session", "s1").put("epoch", 1)
    private lateinit var server: ServerSocket
    private lateinit var scenario: ActivityScenario<Host>
    private lateinit var activity: Host
    private lateinit var plugin: ElizaSurfaceManagerPlugin
    private lateinit var replies: Replies
    private var nextCallback = 0
    private val origin get() = "http://127.0.0.1:${server.localPort}"

    @Before
    fun start() {
        server = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
        Thread {
            while (!server.isClosed) {
                val socket = try { server.accept() } catch (_: Exception) { break }
                socket.use {
                    val path = it.getInputStream().bufferedReader().readLine()?.split(" ")?.getOrNull(1) ?: "/"
                    val body = "<!doctype html><title>Page ${path.trim('/')}</title><p>$path</p>".toByteArray()
                    it.getOutputStream().write(
                        ("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${body.size}\r\n" +
                            "Connection: close\r\n\r\n").toByteArray() + body,
                    )
                }
            }
        }.apply { isDaemon = true }.start()
        scenario = ActivityScenario.launch(Host::class.java)
        scenario.onActivity { host ->
            activity = host
            plugin = host.bridge.getPlugin("ElizaSurfaceManager").instance as ElizaSurfaceManagerPlugin
            replies = Replies(host)
        }
        call("reconcileOwner") { put("desiredIds", JSArray()) }
    }

    @After
    fun stop() {
        runCatching { call("destroySurface") { put("id", SURFACE) } }
        scenario.close()
        server.close()
    }

    /** Calls a plugin method as the host page would, and returns the callback id. */
    private fun send(method: String, keepAlive: Boolean = false, data: JSObject.() -> Unit): String {
        val id = "cb-${nextCallback++}"
        val options = JSObject(identity.toString()).apply(data)
        val call = PluginCall(replies, "ElizaSurfaceManager", id, method, options)
        call.setKeepAlive(keepAlive)
        ElizaSurfaceManagerPlugin::class.java.getMethod(method, PluginCall::class.java).invoke(plugin, call)
        return id
    }

    /** Waits for the next reply to [id]: its data, or `{error}` when it was rejected. */
    private fun answer(id: String): JSONObject {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
        while (System.nanoTime() < deadline) {
            val (callback, result) = replies.results.poll(200, TimeUnit.MILLISECONDS) ?: continue
            if (callback == id) return result
            replies.results.put(callback to result)
        }
        throw AssertionError("no reply to $id")
    }

    /** Waits for the reply to [id], failing on a rejection. */
    private fun reply(id: String): JSONObject = answer(id).also {
        if (it.has("error")) throw AssertionError("$id rejected: ${it.get("error")}")
    }

    private fun call(method: String, data: JSObject.() -> Unit): JSONObject = reply(send(method, data = data))

    private fun listen(event: String): String = send("addListener", keepAlive = true) { put("eventName", event) }

    /** The next navigationChanged event whose page is [path] and has finished loading. */
    private fun navigationChanged(listener: String, path: String): JSONObject {
        while (true) {
            val event = reply(listener)
            if (event.optString("currentUrl").endsWith(path) && event.optInt("progress") == 100) return event
        }
    }

    private fun create(layer: String, intercept: Boolean = false) = call("createSurface") {
        put("id", SURFACE)
        put("url", "$origin/page")
        put("process", "shared")
        put("storage", "shared")
        put("layer", layer)
        put("interceptNavigation", intercept)
    }

    private fun onMain(block: () -> Unit) = instrumentation.runOnMainSync(block)

    /** The FrameLayout the plugin adds surfaces to, and the bridge WebView's branch in it. */
    private fun hostAndBranch(): Pair<ViewGroup, View> {
        val host = findNearestFrameLayoutAncestor(activity.bridge.webView)!!
        return host to hostBranch(host, activity.bridge.webView)!!
    }

    private fun children(host: ViewGroup) = (0 until host.childCount).map(host::getChildAt)

    private fun js(view: WebView, script: String): String {
        val latch = CountDownLatch(1)
        var result = ""
        onMain { view.evaluateJavascript(script) { result = it; latch.countDown() } }
        assertTrue("no result for $script", latch.await(10, TimeUnit.SECONDS))
        return result
    }

    /** Sends a press at [x],[y] (host pixels) to the router and lifts it; true when the page took it. */
    private fun pressThroughRouter(router: View, x: Float, y: Float): Boolean {
        var taken = false
        onMain {
            val now = SystemClock.uptimeMillis()
            val down = MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, x, y, 0)
            taken = router.dispatchTouchEvent(down)
            down.recycle()
            val cancel = MotionEvent.obtain(now, now, MotionEvent.ACTION_CANCEL, x, y, 0)
            router.dispatchTouchEvent(cancel)
            cancel.recycle()
        }
        return taken
    }

    @Test
    fun navigationChangedCarriesTheStateThatGetSurfaceStateReturns() {
        val listener = listen("navigationChanged")
        call("createSurface") {
            put("id", SURFACE)
            put("url", "$origin/first")
            put("process", "shared")
            put("storage", "shared")
        }
        val first = navigationChanged(listener, "/first")
        assertEquals(SURFACE, first.getString("id"))
        assertEquals("bridge-test", first.getString("owner"))
        assertEquals("Page first", first.getString("title"))
        assertEquals(false, first.getBoolean("canGoBack"))

        call("navigate") {
            put("id", SURFACE)
            put("url", "$origin/second")
        }
        val second = navigationChanged(listener, "/second")
        assertEquals("$origin/second", second.getString("currentUrl"))
        assertEquals("Page second", second.getString("title"))
        assertEquals(true, second.getBoolean("canGoBack"))
        assertEquals(false, second.getBoolean("canGoForward"))

        // The page is still, so the state read now is the state the event carried.
        val state = call("getSurfaceState") { put("id", SURFACE) }
        for (key in state.keys()) {
            assertNotNull("event is missing $key", second.opt(key))
            assertEquals(key, state.get(key).toString(), second.get(key).toString())
        }
    }

    @Test
    fun aSurfaceIdIsCreatedAgainOnlyInTheSameLayer() {
        create("below-host")
        // The same options again keep the one surface.
        create("below-host")
        val other = answer(
            send("createSurface") {
                put("id", SURFACE)
                put("process", "shared")
                put("storage", "shared")
                put("layer", "above-host")
            },
        )
        assertTrue(other.optString("error").contains("already exists"))
        var surfaces = 0
        onMain { surfaces = children(hostAndBranch().first).count { it is OccludingSurfaceLayout } }
        assertEquals(1, surfaces)
    }

    @Test
    fun theRouterSitsJustAboveTheBridgeWebViewUntilTheLastBelowHostSurfaceCloses() {
        create("below-host")
        onMain {
            val (host, branch) = hostAndBranch()
            val views = children(host)
            val page = views.single { it is OccludingSurfaceLayout }
            val router = views.single { it is BelowHostInputRouter }
            assertTrue(views.indexOf(page) < views.indexOf(branch))
            assertEquals(views.indexOf(branch) + 1, views.indexOf(router))
        }
        call("destroySurface") { put("id", SURFACE) }
        onMain { assertFalse(children(hostAndBranch().first).any { it is BelowHostInputRouter }) }
    }

    @Test
    fun aPausedPageCancelsItsDialogAndTakesNoTaps() {
        val loaded = listen("navigationChanged")
        val dialogs = listen("dialogRequested")
        create("below-host", intercept = true)
        val outerClip = JSObject().put("x", 0).put("y", 0).put("width", 200).put("height", 200)
            .put("cornerRadii", JSObject().put("topLeft", 0).put("topRight", 0).put("bottomRight", 0).put("bottomLeft", 0))
        call("setBounds") {
            put("id", SURFACE)
            put("x", 0)
            put("y", 0)
            put("width", 200)
            put("height", 200)
            put("outerClip", outerClip)
        }
        call("setOcclusionRects") {
            put("id", SURFACE)
            put("rects", JSArray())
        }
        call("presentSurface") { put("id", SURFACE) }
        navigationChanged(loaded, "/page")

        lateinit var router: View
        lateinit var site: WebView
        var x = 0f
        var y = 0f
        onMain {
            val views = children(hostAndBranch().first)
            router = views.single { it is BelowHostInputRouter }
            site = (views.single { it is OccludingSurfaceLayout } as ViewGroup).getChildAt(0) as WebView
            // The page's CSS (100, 100), wherever the host placed it, in the router's coordinates.
            val page = IntArray(2).also(site::getLocationOnScreen)
            val routerAt = IntArray(2).also(router::getLocationOnScreen)
            val cssPixel = activity.resources.displayMetrics.density
            x = page[0] + 100 * cssPixel - routerAt[0]
            y = page[1] + 100 * cssPixel - routerAt[1]
        }
        instrumentation.waitForIdleSync()
        assertTrue("a shown page takes a press", pressThroughRouter(router, x, y))

        js(site, "window.answer='waiting';setTimeout(()=>{window.answer=String(confirm('Go on?'))})")
        assertEquals(SURFACE, reply(dialogs).getString("id"))
        call("pauseSurface") { put("id", SURFACE) }
        // Nobody can answer a paused page's dialog, so it is cancelled, never accepted.
        val end = SystemClock.uptimeMillis() + 10_000
        while (js(site, "window.answer") == "\"waiting\"") {
            check(SystemClock.uptimeMillis() < end) { "the dialog was not dismissed" }
            SystemClock.sleep(100)
        }
        assertEquals("\"false\"", js(site, "window.answer"))
        assertFalse("a paused page takes no press", pressThroughRouter(router, x, y))

        call("resumeSurface") { put("id", SURFACE) }
        assertTrue("a resumed page takes presses again", pressThroughRouter(router, x, y))
    }

    private companion object {
        const val SURFACE = "bridge-surface"
    }
}
