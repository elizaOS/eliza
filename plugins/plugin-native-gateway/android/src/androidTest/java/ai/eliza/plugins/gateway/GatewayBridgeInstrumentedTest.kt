package ai.eliza.plugins.gateway

import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.getcapacitor.BridgeActivity
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/** Real WebView and native OkHttp client against a loopback protocol peer. */
class GatewayBridgeTestActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(GatewayPlugin::class.java)
        if (Build.VERSION.SDK_INT >= 27) { setTurnScreenOn(true); setShowWhenLocked(true) }
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
}

@RunWith(AndroidJUnit4::class)
class GatewayBridgeInstrumentedTest {
    private class Peer : WebSocketListener() {
        val frames = LinkedBlockingQueue<JSONObject>()
        var replyToClose = true
        lateinit var socket: WebSocket
        override fun onOpen(webSocket: WebSocket, response: Response) { socket = webSocket }
        override fun onMessage(webSocket: WebSocket, text: String) { frames.add(JSONObject(text)) }
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { if (replyToClose) webSocket.close(code, reason) }
        fun next(): JSONObject = frames.poll(5, TimeUnit.SECONDS) ?: throw AssertionError("Native client did not send frame")
        fun respond(request: JSONObject, ok: Boolean, payload: JSONObject) {
            check(socket.send(JSONObject().put("type", "res").put("id", request.getString("id"))
                .put("ok", ok).put(if (ok) "payload" else "error", payload).toString()))
        }
        fun hello(request: JSONObject) = respond(request, true, JSONObject("""{"protocol":3,"auth":{"role":"viewer","scopes":["read"]},"features":{"methods":["echo"],"events":["fixture"]}}"""))
    }

    private fun evaluate(scenario: ActivityScenario<GatewayBridgeTestActivity>, script: String): String {
        val done = CountDownLatch(1)
        var value = "null"
        scenario.onActivity { it.bridge.webView.evaluateJavascript(script) { result -> value = result; done.countDown() } }
        assertTrue("WebView evaluation timed out", done.await(5, TimeUnit.SECONDS))
        return value
    }

    private fun begin(scenario: ActivityScenario<GatewayBridgeTestActivity>, slot: String, method: String, options: JSONObject = JSONObject()) {
        evaluate(scenario, """
            window['$slot'] = null;
            window.Capacitor.nativePromise('Gateway', '$method', $options)
              .then(value => window['$slot'] = JSON.stringify({value: value ?? {}}))
              .catch(error => window['$slot'] = JSON.stringify({error: String(error)}));
        """.trimIndent())
    }

    private fun result(scenario: ActivityScenario<GatewayBridgeTestActivity>, slot: String): JSONObject {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (System.nanoTime() < deadline) {
            val raw = evaluate(scenario, "window['$slot']")
            if (raw != "null") return JSONObject(JSONTokener(raw).nextValue() as String)
            Thread.sleep(20)
        }
        throw AssertionError("Gateway promise $slot did not settle")
    }

    private fun call(scenario: ActivityScenario<GatewayBridgeTestActivity>, method: String): JSONObject {
        begin(scenario, "poll", method)
        val output = result(scenario, "poll")
        assertFalse(output.toString(), output.has("error"))
        return output.getJSONObject("value")
    }

    private fun withPeer(block: (ActivityScenario<GatewayBridgeTestActivity>, Peer, String, MockWebServer) -> Unit) {
        val peer = Peer()
        val server = MockWebServer()
        server.enqueue(MockResponse().withWebSocketUpgrade(peer))
        server.start()
        try {
            ActivityScenario.launch(GatewayBridgeTestActivity::class.java).use { scenario ->
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
                while (evaluate(scenario, "Boolean(window.Capacitor && window.Capacitor.nativePromise)") != "true") {
                    assertTrue("Capacitor initialization timed out", System.nanoTime() < deadline)
                    Thread.sleep(20)
                }
                try { block(scenario, peer, server.url("/gateway").toString().replaceFirst("http", "ws"), server) }
                finally { call(scenario, "disconnect") }
            }
        } finally { server.shutdown() }
    }

    @Test
    fun authenticatedRpcAndEventsCrossTheRealWebSocketAndWebView() = withPeer { scenario, peer, url, _ ->
        evaluate(scenario, "window.events = []; window.Capacitor.Plugins.Gateway.addListener('gatewayEvent', event => window.events.push(event));")
        begin(scenario, "connect", "connect", JSONObject().put("url", url).put("token", "test-token").put("clientName", "android-contract"))
        val request = peer.next()
        assertEquals("connect", request.getString("method"))
        assertEquals("test-token", request.getJSONObject("params").getJSONObject("auth").getString("token"))
        assertEquals(3, request.getJSONObject("params").getInt("minProtocol"))
        peer.hello(request)
        val connected = result(scenario, "connect").getJSONObject("value")
        assertTrue(connected.getBoolean("connected"))
        assertEquals("viewer", connected.getString("role"))
        assertEquals("read", connected.getJSONArray("scopes").getString(0))
        assertTrue(call(scenario, "isConnected").getBoolean("connected"))
        assertEquals(connected.getString("sessionId"), call(scenario, "getConnectionInfo").getString("sessionId"))
        val payload = JSONObject("""{"text":"round trip 🔊","nested":{"items":[1,true,null]}}""")
        begin(scenario, "rpc", "send", JSONObject().put("method", "echo").put("params", payload))
        val rpc = peer.next()
        assertEquals(payload.toString(), rpc.getJSONObject("params").toString())
        peer.respond(rpc, true, rpc.getJSONObject("params"))
        val response = result(scenario, "rpc").getJSONObject("value")
        assertTrue(response.getBoolean("ok"))
        assertEquals(payload.toString(), response.getJSONObject("payload").toString())
        begin(scenario, "denied", "send", JSONObject().put("method", "denied"))
        peer.respond(peer.next(), false, JSONObject().put("code", "DENIED").put("message", "fixture rejection 🔒"))
        val denied = result(scenario, "denied").getJSONObject("value")
        assertFalse(denied.getBoolean("ok"))
        assertEquals("DENIED", denied.getJSONObject("error").getString("code"))
        assertEquals("fixture rejection 🔒", denied.getJSONObject("error").getString("message"))
        peer.socket.send(JSONObject().put("type", "event").put("event", "fixture").put("payload", payload).put("seq", 17).toString())
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (evaluate(scenario, "window.events.length") == "0") {
            assertTrue("Server event did not cross the bridge", System.nanoTime() < deadline)
            Thread.sleep(20)
        }
        assertEquals("17", evaluate(scenario, "window.events[0].seq"))
        call(scenario, "disconnect")
        assertFalse(call(scenario, "isConnected").getBoolean("connected"))
    }

    @Test
    fun replacingAnUnansweredConnectionRejectsTheOldPromiseAndKeepsTheNewSession() = withPeer { scenario, first, url, server ->
        first.replyToClose = false
        begin(scenario, "oldConnect", "connect", JSONObject().put("url", url))
        first.next()
        val second = Peer()
        server.enqueue(MockResponse().withWebSocketUpgrade(second))
        begin(scenario, "newConnect", "connect", JSONObject().put("url", url))
        second.hello(second.next())
        assertTrue(result(scenario, "oldConnect").has("error"))
        assertTrue(result(scenario, "newConnect").getJSONObject("value").getBoolean("connected"))
        begin(scenario, "rpc", "send", JSONObject().put("method", "echo"))
        second.respond(second.next(), true, JSONObject().put("session", "replacement"))
        assertEquals("replacement", result(scenario, "rpc").getJSONObject("value").getJSONObject("payload").getString("session"))
        assertTrue(call(scenario, "isConnected").getBoolean("connected"))
    }

    @Test
    fun anUnsupportedHandshakeProtocolRejectsInsteadOfFabricatingSuccess() = withPeer { scenario, peer, url, _ ->
        begin(scenario, "connect", "connect", JSONObject().put("url", url))
        peer.respond(peer.next(), true, JSONObject().put("protocol", 99))
        assertTrue(result(scenario, "connect").has("error"))
        assertFalse(call(scenario, "isConnected").getBoolean("connected"))
    }

    @Test
    fun reconnectAuthenticatesANewSocketAfterThePeerCloses() = withPeer { scenario, first, url, server ->
        begin(scenario, "connect", "connect", JSONObject().put("url", url))
        first.hello(first.next())
        assertTrue(result(scenario, "connect").getJSONObject("value").getBoolean("connected"))
        val second = Peer()
        server.enqueue(MockResponse().withWebSocketUpgrade(second))
        assertTrue(first.socket.close(1001, "fixture reconnect"))
        second.hello(second.next())
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (!call(scenario, "isConnected").getBoolean("connected")) {
            assertTrue("Gateway did not reauthenticate", System.nanoTime() < deadline)
            Thread.sleep(20)
        }
        begin(scenario, "rpc", "send", JSONObject().put("method", "echo"))
        second.respond(second.next(), true, JSONObject().put("session", "reconnected"))
        assertEquals("reconnected", result(scenario, "rpc").getJSONObject("value").getJSONObject("payload").getString("session"))
    }

    @Test
    fun rejectedAuthenticationNeverReportsConnected() = withPeer { scenario, peer, url, _ ->
        begin(scenario, "connect", "connect", JSONObject().put("url", url).put("token", "invalid-test-token"))
        val request = peer.next()
        assertFalse("Opening the socket is not successful authentication", call(scenario, "isConnected").getBoolean("connected"))
        peer.respond(request, false, JSONObject().put("code", "UNAUTHORIZED").put("message", "test credential rejected"))
        assertTrue(result(scenario, "connect").has("error"))
        assertFalse(call(scenario, "isConnected").getBoolean("connected"))
    }

    @Test
    fun disconnectSettlesAnUnansweredHandshake() = withPeer { scenario, peer, url, _ ->
        peer.replyToClose = false
        begin(scenario, "connect", "connect", JSONObject().put("url", url))
        assertEquals("connect", peer.next().getString("method"))
        call(scenario, "disconnect")
        assertTrue(result(scenario, "connect").has("error"))
        assertFalse(call(scenario, "isConnected").getBoolean("connected"))
    }

    @Test
    fun disconnectSettlesAnUnansweredRpcWithoutWaitingForItsTimeout() = withPeer { scenario, peer, url, _ ->
        begin(scenario, "connect", "connect", JSONObject().put("url", url))
        peer.hello(peer.next())
        assertTrue(result(scenario, "connect").getJSONObject("value").getBoolean("connected"))
        peer.replyToClose = false
        begin(scenario, "rpc", "send", JSONObject().put("method", "hold"))
        assertEquals("hold", peer.next().getString("method"))
        call(scenario, "disconnect")
        assertFalse(result(scenario, "rpc").getJSONObject("value").getBoolean("ok"))
        assertFalse(call(scenario, "isConnected").getBoolean("connected"))
    }
}
