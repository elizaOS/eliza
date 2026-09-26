package ai.eliza.plugins.websiteblocker

import android.content.Context
import android.app.KeyguardManager
import android.net.VpnService
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
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
        // Showing the test activity over the lock screen does not unlock the
        // system VPN consent activity that it launches.
        val keyguard = instrumentation.targetContext.getSystemService(KeyguardManager::class.java)
        assertFalse("VPN consent tests require an emulator without a secure screen lock", keyguard.isKeyguardSecure)
        device.wakeUp()
        scenario.onActivity { keyguard.requestDismissKeyguard(it, null) }
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (keyguard.isKeyguardLocked) {
            assertTrue("Emulator lock screen did not dismiss before VPN consent", System.nanoTime() < deadline)
            Thread.sleep(20)
        }
        while (evaluate(scenario, "Boolean(window.Capacitor && window.Capacitor.nativePromise)") != "true") {
            assertTrue("Capacitor initialization timed out", System.nanoTime() < deadline)
            Thread.sleep(20)
        }
    }

    private fun startWithConsent(scenario: ActivityScenario<WebsiteBlockerBridgeTestActivity>, options: JSONObject) {
        val consentRequired = VpnService.prepare(instrumentation.targetContext) != null
        begin(scenario, "startBlock", options)
        if (consentRequired) {
            val approve = device.wait(Until.findObject(By.res("android", "button1").pkg("com.android.vpndialogs")), 10000)
            if (approve == null) {
                val hierarchy = ByteArrayOutputStream()
                device.dumpWindowHierarchy(hierarchy)
                export("vpn-consent-missing.xml", hierarchy.toByteArray())
                throw AssertionError("Android VPN approval button did not appear on the unlocked emulator")
            }
            approve.click()
        }
        assertTrue(result(scenario).getBoolean("success"))
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
        if (active) {
            val ready = CountDownLatch(1)
            val callback = object : ConnectivityManager.NetworkCallback() {
                private var vpn: Network? = null

                override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
                    vpn = if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) network else null
                }

                override fun onLinkPropertiesChanged(network: Network, properties: LinkProperties) {
                    // activeNetwork can expose the VPN before netd installs its DNS route.
                    // Android delivers link properties after applying those routes; do not
                    // send the single acceptance packet from a synchronous capability poll.
                    val dns = InetAddress.getByName("10.77.0.2")
                    if (network == vpn && properties.dnsServers.contains(dns) &&
                        properties.routes.any { it.destination.address == dns && it.destination.prefixLength == 32 }
                    ) ready.countDown()
                }
            }
            manager.registerDefaultNetworkCallback(callback)
            try {
                assertTrue("VPN DNS route did not become ready", ready.await(timeoutSeconds, TimeUnit.SECONDS))
            } finally {
                manager.unregisterNetworkCallback(callback)
            }
        } else {
            while (hasVpn()) {
                assertTrue("VPN did not become inactive", System.nanoTime() < deadline)
                Thread.sleep(50)
            }
        }
    }

    private fun dnsRequest(host: String): ByteArray {
        val bytes = ByteArrayOutputStream()
        DataOutputStream(bytes).use { out ->
            out.writeShort(0x4321); out.writeShort(0x0100)
            out.writeShort(1); repeat(3) { out.writeShort(0) }
            for (label in host.split('.')) { out.writeByte(label.length); out.writeBytes(label) }
            out.writeByte(0); out.writeShort(1); out.writeShort(1)
        }
        return bytes.toByteArray()
    }

    private fun bindVpnSocket(socket: DatagramSocket) {
        val manager = instrumentation.targetContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = requireNotNull(manager.activeNetwork)
        check(manager.getNetworkCapabilities(network)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true)
        // Target the observed VPN explicitly instead of racing default-route updates.
        // The separate InetAddress assertions still exercise Android's default resolver.
        network.bindSocket(socket)
        socket.connect(InetAddress.getByName("10.77.0.2"), 53)
    }

    private fun query(host: String, transcript: JSONArray, timeoutMs: Int = 10000): Int {
        val request = dnsRequest(host)
        val response = DatagramSocket().use { socket ->
            socket.soTimeout = timeoutMs
            bindVpnSocket(socket)
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
                startWithConsent(scenario, JSONObject().put("websites", JSONArray().put("example.com")))
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
                if (InstrumentationRegistry.getArguments().getString("dnsOutage") == "1") {
                    DnsOutageFixture().use { outage ->
                        val pending = mutableListOf<DatagramSocket>()
                        try {
                            val request = dnsRequest("example.org")
                            repeat(72) {
                                val socket = DatagramSocket()
                                pending.add(socket)
                                bindVpnSocket(socket)
                                socket.send(DatagramPacket(request, request.size))
                            }
                            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
                            while (outage.droppedPackets() < 4L) {
                                assertTrue("VPN never attempted upstream DNS", System.nanoTime() < deadline)
                                Thread.sleep(20)
                            }
                            var rejectedOverload = false
                            for (socket in pending) {
                                socket.soTimeout = 10
                                val packet = DatagramPacket(ByteArray(4096), 4096)
                                try {
                                    socket.receive(packet)
                                    if (packet.length >= 12 && (packet.data[3].toInt() and 15) == 2) {
                                        rejectedOverload = true
                                        break
                                    }
                                } catch (_: SocketTimeoutException) {
                                    // Occupied workers and queued requests should still be waiting.
                                }
                            }
                            assertTrue("A saturated forwarding queue must return explicit SERVFAIL", rejectedOverload)
                            val started = System.nanoTime()
                            try {
                                assertEquals("Blocked DNS must remain responsive during upstream timeout", 3,
                                    query("example.net", transcript, 1500))
                            } finally {
                                export("vpn-upstream-outage.json", JSONObject()
                                    .put("concurrentRequests", pending.size)
                                    .put("overloadReturnedServerFailure", rejectedOverload)
                                    .put("droppedUpstreamPackets", outage.droppedPackets())
                                    .put("blockedResponseMs", TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started))
                                    .toString(2).toByteArray())
                            }
                        } finally {
                            pending.forEach { it.close() }
                        }
                    }
                }
            } catch (error: Throwable) {
                failure = error
                throw error
            } finally {
                export("vpn-dns-transcript.json", transcript.toString(2).toByteArray())
                try {
                    begin(scenario, "stopBlock")
                    assertTrue(result(scenario).getBoolean("success"))
                    waitVpn(false)
                    if (InstrumentationRegistry.getArguments().getString("dnsOutage") == "1") {
                        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
                        while (Thread.getAllStackTraces().keys.any { it.isAlive && it.name == "ElizaWebsiteDns" }) {
                            if (System.nanoTime() >= deadline) {
                                export("vpn-dns-worker-stacks.txt", Thread.getAllStackTraces().entries
                                    .filter { it.key.name == "ElizaWebsiteDns" || it.key.name == "main" }
                                    .joinToString("\n\n") { "${it.key.name} ${it.key.state}\n${it.value.joinToString("\n")}" }.toByteArray())
                                fail("Stopping VPN must cancel upstream sockets and workers")
                            }
                            Thread.sleep(20)
                        }
                        export("vpn-upstream-outage-cleanup.json", JSONObject()
                            .put("activeVpn", hasVpn()).put("remainingDnsWorkers", 0).toString().toByteArray())
                    }
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
                startWithConsent(scenario, JSONObject().put("websites", JSONArray().put("example.com")).put("durationMinutes", 1))
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
