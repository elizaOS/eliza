/**
 * Drives the plugin through a real Capacitor bridge, as the host page would, and loads
 * pages from a local server: the state each `navigationChanged` carries.
 */
package ai.eliza.plugins.browsersurface

import android.os.Bundle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.getcapacitor.BridgeActivity
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.MessageHandler
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginResult
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
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

    private val identity = JSObject().put("owner", "bridge-test").put("session", "s1").put("epoch", 1)
    private lateinit var server: ServerSocket
    private lateinit var scenario: ActivityScenario<Host>
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

    private companion object {
        const val SURFACE = "bridge-surface"
    }
}
