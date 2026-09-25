package ai.eliza.plugins.websiteblocker

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import java.net.DatagramSocket
import java.net.DatagramPacket
import java.net.UnknownHostException
import java.net.SocketTimeoutException
import java.net.InetAddress
import java.io.DataOutputStream
import org.json.JSONArray
import java.io.ByteArrayOutputStream
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.view.WindowManager
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.getcapacitor.BridgeActivity
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Exercises real DNS packets through the production VPN after Android consent. */
class WebsiteBlockerBridgeTestActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(WebsiteBlockerPlugin::class.java)
        if (Build.VERSION.SDK_INT >= 27) { setTurnScreenOn(true); setShowWhenLocked(true) }
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
}

@RunWith(AndroidJUnit4::class)
class WebsiteBlockerBridgeInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val device get() = UiDevice.getInstance(instrumentation)

    private fun evaluate(scenario: ActivityScenario<WebsiteBlockerBridgeTestActivity>, script: String): String {
        val done = CountDownLatch(1)
        var value = "null"
        scenario.onActivity { it.bridge.webView.evaluateJavascript(script) { result -> value = result; done.countDown() } }
        assertTrue("WebView evaluation timed out", done.await(5, TimeUnit.SECONDS))
        return value
    }

    private fun begin(scenario: ActivityScenario<WebsiteBlockerBridgeTestActivity>, method: String, options: JSONObject = JSONObject()) {
        evaluate(scenario, """
            window.result = null;
            window.Capacitor.nativePromise('ElizaWebsiteBlocker', '$method', $options)
              .then(value => window.result = JSON.stringify({value: value ?? {}}))
              .catch(error => window.result = JSON.stringify({error: String(error)}));
        """.trimIndent())
    }

    private fun result(scenario: ActivityScenario<WebsiteBlockerBridgeTestActivity>): JSONObject {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
        while (System.nanoTime() < deadline) {
            val raw = evaluate(scenario, "window.result")
            if (raw != "null") {
                val parsed = JSONObject(JSONTokener(raw).nextValue() as String)
                assertFalse("Native blocker rejected: $parsed", parsed.has("error"))
                return parsed.getJSONObject("value")
            }
            Thread.sleep(30)
        }
        throw AssertionError("Website blocker promise did not settle")
    }

    private fun ready(scenario: ActivityScenario<WebsiteBlockerBridgeTestActivity>) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (evaluate(scenario, "Boolean(window.Capacitor && window.Capacitor.nativePromise)") != "true") {
            assertTrue("Capacitor initialization timed out", System.nanoTime() < deadline)
            Thread.sleep(20)
        }
    }

    private fun export(name: String, bytes: ByteArray) {
        instrumentation.sendStatus(2, Bundle().apply {
            putString("nativeArtifactName", name)
            putString("nativeArtifactBase64", Base64.encodeToString(bytes, Base64.NO_WRAP))
        })
    }

    private fun hasVpn(): Boolean {
        val manager = instrumentation.targetContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        return manager.allNetworks.any { manager.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true }
    }

    private fun waitVpn(active: Boolean, timeoutSeconds: Long = 10) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(timeoutSeconds)
        val manager = instrumentation.targetContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        fun ready() = if (active) {
            manager.getNetworkCapabilities(manager.activeNetwork)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true
        } else !hasVpn()
        while (!ready()) {
            assertTrue("VPN did not become active=$active", System.nanoTime() < deadline)
            Thread.sleep(50)
        }
    }

    private fun query(host: String, transcript: JSONArray): Int {
        val bytes = ByteArrayOutputStream()
        DataOutputStream(bytes).use { out ->
            out.writeShort(0x4321); out.writeShort(0x0100)
            out.writeShort(1); repeat(3) { out.writeShort(0) }
            for (label in host.split('.')) { out.writeByte(label.length); out.writeBytes(label) }
            out.writeByte(0); out.writeShort(1); out.writeShort(1)
        }
        val request = bytes.toByteArray()
        val response = DatagramSocket().use { socket ->
            socket.soTimeout = 10000
            socket.connect(InetAddress.getByName("10.77.0.2"), 53)
            socket.send(DatagramPacket(request, request.size))
            val packet = DatagramPacket(ByteArray(4096), 4096)
            try {
                socket.receive(packet)
            } catch (error: SocketTimeoutException) {
                val manager = instrumentation.targetContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
                val threads = JSONArray()
                Thread.getAllStackTraces().forEach { (thread, stack) ->
                    if (thread.name == "ElizaWebsiteBlockerVpn") {
                        threads.put(JSONObject().put("state", thread.state.toString())
                            .put("stack", JSONArray(stack.map { it.toString() })))
                    }
                }
                transcript.put(JSONObject().put("host", host).put("error", "DNS response timed out")
                    .put("activeNetwork", manager.activeNetwork?.toString())
                    .put("capabilities", manager.getNetworkCapabilities(manager.activeNetwork)?.toString())
                    .put("links", manager.getLinkProperties(manager.activeNetwork)?.toString())
                    .put("tunnelThreads", threads))
                export("vpn-dns-timeout.json", transcript.toString(2).toByteArray())
                throw error
            }
            packet.data.copyOf(packet.length)
        }
        assertTrue("DNS response header missing", response.size >= 12)
        assertEquals(0x43, response[0].toInt() and 255)
        assertEquals(0x21, response[1].toInt() and 255)
        assertTrue("DNS response bit missing", response[2].toInt() and 128 != 0)
        val code = response[3].toInt() and 15
        transcript.put(JSONObject().put("host", host).put("rcode", code)
            .put("request", Base64.encodeToString(request, Base64.NO_WRAP))
            .put("response", Base64.encodeToString(response, Base64.NO_WRAP)))
        return code
    }

    @Test
    fun vpnBlocksDnsAndAppliesPolicyChangesWithoutRestart() {
        assertFalse("A separate VPN is already active; leave it untouched", hasVpn())
        val transcript = JSONArray()
        ActivityScenario.launch(WebsiteBlockerBridgeTestActivity::class.java).use { scenario ->
            ready(scenario)
            var failure: Throwable? = null
            try {
                begin(scenario, "startBlock", JSONObject().put("websites", JSONArray().put("example.com")))
                device.wait(Until.findObject(By.res("android", "button1")), 3000)?.click()
                assertTrue(result(scenario).getBoolean("success"))
                waitVpn(true)
                assertEquals("Blocked hostname must return NXDOMAIN", 3, query("example.com", transcript))
                assertEquals("Unblocked DNS must still resolve", 0, query("example.org", transcript))
                assertThrows("Android resolver must honor the VPN", UnknownHostException::class.java) {
                    InetAddress.getAllByName("www.example.com")
                }
                assertTrue("Android resolver must preserve allowed traffic", InetAddress.getAllByName("example.org").isNotEmpty())
                begin(scenario, "startBlock", JSONObject().put("websites", JSONArray().put("example.net")))
                assertTrue(result(scenario).getBoolean("success"))
                // Service intents are asynchronous; allow dispatch, not a VPN restart.
                Thread.sleep(300)
                assertEquals("Updated policy must block the new hostname", 3, query("example.net", transcript))
                assertEquals("Removed hostname must resolve again", 0, query("example.com", transcript))
            } catch (error: Throwable) {
                failure = error
                throw error
            } finally {
                export("vpn-dns-transcript.json", transcript.toString(2).toByteArray())
                try {
                    begin(scenario, "stopBlock")
                    assertTrue(result(scenario).getBoolean("success"))
                    waitVpn(false)
                } catch (cleanupError: Throwable) {
                    if (failure != null) failure.addSuppressed(cleanupError) else throw cleanupError
                }
            }
        }
    }

    @Test
    fun timedBlockReleasesVpnAndCanRestart() {
        assertFalse("A separate VPN is already active; leave it untouched", hasVpn())
        ActivityScenario.launch(WebsiteBlockerBridgeTestActivity::class.java).use { scenario ->
            ready(scenario)
            var failure: Throwable? = null
            try {
                begin(scenario, "startBlock", JSONObject().put("websites", JSONArray().put("example.com")).put("durationMinutes", 1))
                device.wait(Until.findObject(By.res("android", "button1")), 3000)?.click()
                assertTrue(result(scenario).getBoolean("success"))
                waitVpn(true)
                val activeAt = android.os.SystemClock.elapsedRealtime()
                waitVpn(false, 75)
                val activeMs = android.os.SystemClock.elapsedRealtime() - activeAt
                assertTrue("One-minute block ended prematurely: $activeMs ms", activeMs >= 50000)
                export("vpn-expiry.json", JSONObject().put("durationMinutes", 1).put("observedActiveMs", activeMs).toString(2).toByteArray())
                begin(scenario, "getStatus")
                assertFalse("Expired block must be inactive", result(scenario).getBoolean("active"))
                begin(scenario, "startBlock", JSONObject().put("websites", JSONArray().put("example.net")))
                assertTrue(result(scenario).getBoolean("success"))
                waitVpn(true)
                val transcript = JSONArray()
                assertEquals(3, query("example.net", transcript))
                export("vpn-restart-transcript.json", transcript.toString(2).toByteArray())
            } catch (error: Throwable) {
                failure = error
                throw error
            } finally {
                try {
                    begin(scenario, "stopBlock")
                    assertTrue(result(scenario).getBoolean("success"))
                    waitVpn(false)
                } catch (cleanupError: Throwable) {
                    if (failure != null) failure.addSuppressed(cleanupError) else throw cleanupError
                }
            }
        }
    }

}
