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
    private var browserFixture: java.net.ServerSocket? = null
    private var browserRestorationPaintMs: Long? = null
    private val submittedRequests = java.util.concurrent.atomic.AtomicInteger(0)
    private val approvedPageRequests = java.util.concurrent.atomic.AtomicInteger(0)

    @org.junit.After
    fun closeBrowserFixture() { browserFixture?.close() }

    private fun browserFixtureOrigin(): String {
        browserFixture?.let { return "http://127.0.0.1:${it.localPort}" }
        val server = java.net.ServerSocket(0, 8, java.net.InetAddress.getByName("127.0.0.1"))
        browserFixture = server
        val origin = "http://127.0.0.1:${server.localPort}"
        kotlin.concurrent.thread(isDaemon = true, name = "native-browser-fixture") {
            while (!server.isClosed) {
                val socket = try { server.accept() } catch (error: java.net.SocketException) {
                    if (server.isClosed) break else throw error
                }
                socket.use {
                    it.soTimeout = 5000
                    val input = it.getInputStream().bufferedReader()
                    val request = input.readLine().split(" ")
                    val path = request[1]
                    if (path == "/submitted" && request[0] == "POST") submittedRequests.incrementAndGet()
                    if (path == "/next") approvedPageRequests.incrementAndGet()
                    while (!input.readLine().isNullOrEmpty()) { }
                    val other = "http://localhost:${server.localPort}/next"
                    val response = if (path == "/redirect") {
                        "HTTP/1.1 302 Found\r\nLocation: $other\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    } else {
                        val title = when (path) { "/submitted" -> "Submitted fixture"; "/first" -> "First fixture"; "/second" -> "Second fixture"; "/same" -> "Same fixture"; "/next" -> "Approved fixture"; else -> "Control fixture" }
                        val body = if (path == "/first" || path == "/second") {
                            val text = if (path == "/first") "First visible café 漢字" else "Second visible page"
                            """<!doctype html><title>$title</title><main>$text</main><div id="loaded"></div><script>document.querySelector('#loaded').textContent=String(performance.timeOrigin)+'-'+Math.random()</script><span hidden>hidden fixture</span><input value="private fixture">"""
                        } else """<!doctype html><title>$title</title><label>Search query<input id="query"></label><input type="password" value="private-control-value"><button type="button" id="increment" onclick="document.querySelector('output').textContent++">Increment</button><output>0</output><label>Language<select id="language"><option value="internal-en">English</option><option value="internal-fr">French</option></select></label><button type="button" id="history-state" onclick="history.pushState({step:1},'', '#updated')">Change history</button><a id="same-origin" href="$origin/same">Same origin</a><a id="cross-origin" href="$other">Other origin</a><script>window.elizaSurfaceControl={postMessage(){throw new Error("page-owned channel")}};window.__elizaBrowserControlV1={snapshotId:"page-owned snapshot"};</script>"""
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: ${body.toByteArray().size}\r\nConnection: close\r\n\r\n$body"
                    }
                    it.getOutputStream().write(response.toByteArray())
                }
            }
        }
        return origin
    }

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
        val arguments = InstrumentationRegistry.getArguments()
        descriptor.put("surfaceControl", arguments.getString("surfaceControl") == "1")
        arguments.getString("smsCleanupBody")?.let { body ->
            check(Build.HARDWARE in setOf("ranchu", "goldfish"))
            check(body.startsWith("Eliza native SMS round trip "))
            check(descriptor.getString("directory") == "plugin-native-messages")
            val instrumentation = InstrumentationRegistry.getInstrumentation()
            fun shell(command: String) = instrumentation.uiAutomation.executeShellCommand(command).use {
                android.os.ParcelFileDescriptor.AutoCloseInputStream(it).readBytes()
            }
            // Grant write access only after the sender/receiver assertions, and
            // delete only this run's synthetic body. Normal sending never gets it.
            shell("appops set ${context.packageName} android:write_sms allow")
            try {
                context.contentResolver.delete(android.provider.Telephony.Sms.CONTENT_URI, "body = ? OR body = ?", arrayOf(body, body.trim()))
                context.contentResolver.query(android.provider.Telephony.Sms.CONTENT_URI, arrayOf("_id"), "body = ? OR body = ?", arrayOf(body, body.trim()), null).use {
                    assertNotNull(it)
                    assertEquals("SMS fixture must be removed", 0, it!!.count)
                }
            } finally {
                shell("appops set ${context.packageName} android:write_sms default")
            }
            return
        }
        arguments.getString("smsRole")?.let { role ->
            check(Build.HARDWARE in setOf("ranchu", "goldfish"))
            check(descriptor.getString("directory") == "plugin-native-messages")
            check(role in setOf("sender", "receiver"))
            for (key in listOf("smsPeerPort", "smsSenderPort")) {
                val port = requireNotNull(arguments.getString(key)).toInt()
                check(port in 5554..5682 && port % 2 == 0)
                descriptor.put(key, port.toString())
            }
            descriptor.put("smsRole", role)
            descriptor.put("smsLoopback", arguments.getString("smsLoopback") == "true")
            descriptor.put("smsBody", requireNotNull(arguments.getString("smsBody")))
        }
        if (arguments.getString("systemControlsRestore") == "1") {
            check(descriptor.getString("directory") == "plugin-native-system")
            SystemControlsFixture.restore(context)
            return
        }
        if (arguments.getString("systemControlsPrepareRecovery") == "1") {
            check(descriptor.getString("directory") == "plugin-native-system")
            val fixture = SystemControlsFixture(context)
            try {
                fixture.run(leaveForRecovery = true) { name, expected ->
                    descriptor.put("systemStage", name).put("systemExpected", expected)
                    runContract(descriptor, script)
                }
            } catch (error: Throwable) {
                try { fixture.close() } catch (cleanup: Throwable) { error.addSuppressed(cleanup) }
                throw error
            }
            // Deliberately do not close: the next instrumentation process owns recovery.
            return
        }
        if (arguments.getString("systemControls") == "1") {
            check(descriptor.getString("directory") == "plugin-native-system")
            SystemControlsFixture(context).use { fixture ->
                fixture.run { name, expected ->
                    descriptor.put("systemStage", name).put("systemExpected", expected)
                    runContract(descriptor, script)
                }
            }
            return
        }
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
        if (descriptor.getString("directory") == "plugin-native-contacts") {
            ContactsImportFixture(context).use { fixture ->
                descriptor.put("contactsFixture", fixture.descriptor)
                runContract(descriptor, script) { result ->
                    fixture.verifyImported(result.getJSONObject("contacts").getJSONObject("imported").getJSONArray("imported"))
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

    private fun runContract(descriptor: JSONObject, script: String, verifyResult: (JSONObject) -> Unit = {}) {
        ActivityScenario.launch(NativeBridgeTestActivity::class.java).use { scenario ->
            scenario.moveToState(Lifecycle.State.RESUMED)
            assertEquals("Bridge host must be foregrounded", Lifecycle.State.RESUMED, scenario.state)
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
            while (evaluate(scenario, "Boolean(window.Capacitor && window.Capacitor.nativePromise)") != "true") {
                assertTrue("Capacitor initialization timed out", System.nanoTime() < deadline)
                Thread.sleep(50)
            }
            evaluate(scenario, "window.nativeDescriptor = $descriptor; $script")
            // The extended surface flow includes real navigation, compositor capture,
            // selection, activity pause and redirect checks. Each step retains its own deadline.
            val contractSeconds = if (descriptor.optBoolean("surfaceControl", false)) 120L else 30L
            val finishDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(contractSeconds)
            while (System.nanoTime() < finishDeadline) {
                if (descriptor.getString("directory") == "plugin-native-browser-surface") {
                    if (evaluate(scenario, "window.nativeBrowserPauseRequested === true") == "true") {
                        evaluate(scenario, "window.nativeBrowserPauseRequested = false")
                        scenario.moveToState(Lifecycle.State.STARTED)
                        try {
                            evaluate(scenario, """window.nativePausedControlResult = null;
                                window.Capacitor.nativePromise("ElizaSurfaceManager", "controlPage", {
                                  owner: "bridge-test", session: "session-1", epoch: 1,
                                  id: "bridge-surface", command: {subaction: "snapshot"}
                                }).then(() => window.nativePausedControlResult = "allowed",
                                  error => window.nativePausedControlResult = error.code);""")
                            val pauseDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
                            var result = evaluate(scenario, "window.nativePausedControlResult")
                            while (result == "null" && System.nanoTime() < pauseDeadline) {
                                Thread.sleep(50)
                                result = evaluate(scenario, "window.nativePausedControlResult")
                            }
                            assertEquals("A paused host must reject browser control", "\"UNAVAILABLE\"", result)
                        } finally {
                            scenario.moveToState(Lifecycle.State.RESUMED)
                        }
                        evaluate(scenario, "window.nativeBrowserPauseComplete = true")
                    }
                    if (evaluate(scenario, "window.nativeBrowserFixtureOriginRequested === true") == "true") {
                        evaluate(scenario, "window.nativeBrowserFixtureOriginRequested = false")
                        evaluate(scenario, "window.nativeBrowserControlOrigin = ${JSONObject.quote(browserFixtureOrigin())}")
                    }
                    if (evaluate(scenario, "window.nativeBrowserPostFixtureRequested === true") == "true") {
                        evaluate(scenario, "window.nativeBrowserPostFixtureRequested = false")
                        scenario.onActivity { activity ->
                            val pages = mutableListOf<android.webkit.WebView>()
                            fun visit(view: android.view.View) {
                                if (view is android.webkit.WebView && view !== activity.bridge.webView && view.isShown) pages.add(view)
                                if (view is android.view.ViewGroup) for (i in 0 until view.childCount) visit(view.getChildAt(i))
                            }
                            visit(activity.window.decorView)
                            check(pages.size == 1)
                            pages.single().postUrl("${browserFixtureOrigin()}/submitted", "fixture=one".toByteArray())
                        }
                    }
                    if (evaluate(scenario, "window.nativeBrowserControlFixtureRequested === true") == "true") {
                        evaluate(scenario, "window.nativeBrowserControlFixtureRequested = false")
                        val origin = browserFixtureOrigin()
                        evaluate(scenario, "window.nativeBrowserControlOrigin = ${JSONObject.quote(origin)}")
                        scenario.onActivity { activity ->
                            val pages = mutableListOf<android.webkit.WebView>()
                            fun visit(view: android.view.View) {
                                if (view is android.webkit.WebView && view !== activity.bridge.webView && view.isShown) pages.add(view)
                                if (view is android.view.ViewGroup) for (i in 0 until view.childCount) visit(view.getChildAt(i))
                            }
                            visit(activity.window.decorView)
                            check(pages.size == 1)
                            pages.single().loadUrl("$origin/")
                        }
                    }
                    val captureRaw = evaluate(scenario, "JSON.stringify(window.nativeBrowserCapture || null)")
                    val captureText = JSONTokener(captureRaw).nextValue() as? String
                    if (captureText != null && captureText != "null") {
                        val capture = JSONObject(captureText)
                        if (!capture.getBoolean("done")) {
                            val name = capture.getString("name")
                            check(name in listOf("browser-before-invalid-present.png", "browser-after-invalid-present.png", "browser-guidance.png", "browser-guidance-paused.png", "browser-guidance-cleared.png"))
                            val drawn = CountDownLatch(1)
                            scenario.onActivity { activity ->
                                val webViews = mutableListOf<android.webkit.WebView>()
                                fun visit(view: android.view.View) {
                                    if (view is android.webkit.WebView && view.isShown) webViews.add(view)
                                    if (view is android.view.ViewGroup) for (i in 0 until view.childCount) visit(view.getChildAt(i))
                                }
                                visit(activity.window.decorView)
                                assertEquals("The native page must be shown before capture: $name", 1,
                                    webViews.count { it !== activity.bridge.webView })
                                val pending = java.util.concurrent.atomic.AtomicInteger(webViews.size)
                                if (webViews.isEmpty()) drawn.countDown()
                                for (view in webViews) view.postVisualStateCallback(0L, object : android.webkit.WebView.VisualStateCallback() {
                                    override fun onComplete(requestId: Long) {
                                        if (pending.decrementAndGet() == 0) activity.window.decorView.postOnAnimation {
                                            activity.window.decorView.postOnAnimation { drawn.countDown() }
                                        }
                                    }
                                })
                            }
                            assertTrue("Native presentation did not render", drawn.await(5, TimeUnit.SECONDS))
                            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
                            var bitmap = checkNotNull(InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot())
                            if (name == "browser-guidance-paused.png") {
                                // A bridge reply can precede the compositor frame. Require
                                // the shared renderer's grey paused tag in the actual pixels.
                                fun hasPausedTag(image: android.graphics.Bitmap): Boolean {
                                    var pixels = 0
                                    for (y in 0 until image.height step 4) {
                                        for (x in 0 until image.width step 4) {
                                            if (image.getPixel(x, y) == android.graphics.Color.rgb(74, 74, 71)) pixels++
                                            if (pixels >= 100) return true
                                        }
                                    }
                                    return false
                                }
                                val started = android.os.SystemClock.elapsedRealtime()
                                while (!hasPausedTag(bitmap) && android.os.SystemClock.elapsedRealtime() - started < 1000) {
                                    bitmap.recycle()
                                    Thread.sleep(50)
                                    bitmap = checkNotNull(InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot())
                                }
                                assertTrue("Paused native guidance must paint its grey tag", hasPausedTag(bitmap))
                            }
                            if (name == "browser-guidance-cleared.png") {
                                // The fixture's opaque page starts at screen (0,0). If its
                                // compositor layer is missing, the dark status bar is exposed.
                                val started = android.os.SystemClock.elapsedRealtime()
                                while (bitmap.getPixel(5, 5) != android.graphics.Color.WHITE &&
                                    android.os.SystemClock.elapsedRealtime() - started < 1000) {
                                    bitmap.recycle()
                                    Thread.sleep(50)
                                    bitmap = checkNotNull(InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot())
                                }
                                browserRestorationPaintMs = android.os.SystemClock.elapsedRealtime() - started
                                assertEquals("Restored native page must paint above the host", android.graphics.Color.WHITE, bitmap.getPixel(5, 5))
                            }
                            val bytes = java.io.ByteArrayOutputStream()
                            try { check(bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, bytes)) }
                            finally { bitmap.recycle() }
                            InstrumentationRegistry.getInstrumentation().sendStatus(2, Bundle().apply {
                                putString("nativeArtifactName", name)
                                putString("nativeArtifactBase64", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP))
                            })
                            evaluate(scenario, "window.nativeBrowserCapture.done = true")
                        }
                    }
                }
                val raw = evaluate(scenario, "window.nativeContractResult")
                if (raw != "null") {
                    val result = JSONObject(JSONTokener(raw).nextValue() as String)
                    if (descriptor.getString("directory") == "plugin-native-canvas") {
                        val evidence = evaluate(scenario, "JSON.stringify(window.nativeCanvasEvidence || {})")
                        result.put("canvas", JSONObject(JSONTokener(evidence).nextValue() as String))
                        InstrumentationRegistry.getInstrumentation().sendStatus(2, Bundle().apply {
                            putString("nativeArtifactName", "canvas-pixels.json")
                            putString("nativeArtifactBase64", Base64.encodeToString(result.toString().toByteArray(), Base64.NO_WRAP))
                        })
                    }
                    assertFalse("Native contract failed: $result", result.has("error"))
                    assertTrue("Contract must assert native behavior", result.getInt("assertions") > 0)
                    if (descriptor.getString("directory") == "plugin-native-browser-surface") {
                        val evidence = evaluate(scenario, "JSON.stringify(window.nativeBrowserEvidence)")
                        result.put("browser", JSONObject(JSONTokener(evidence).nextValue() as String))
                        browserRestorationPaintMs?.let { result.put("restorationPaintWaitMs", it) }
                        if (descriptor.getBoolean("surfaceControl")) {
                            assertEquals("Only the approved host load may request the other origin", 1, approvedPageRequests.get())
                            result.put("approvedPageRequests", approvedPageRequests.get())
                            assertEquals("History traversal must not repeat the fixture POST", 1, submittedRequests.get())
                            result.put("submittedRequests", submittedRequests.get())
                        }
                        InstrumentationRegistry.getInstrumentation().sendStatus(2, Bundle().apply {
                            putString("nativeArtifactName", "browser-navigation.json")
                            putString("nativeArtifactBase64", Base64.encodeToString(result.toString().toByteArray(), Base64.NO_WRAP))
                        })
                    }
                    if (descriptor.has("contactsFixture")) {
                        val evidence = evaluate(scenario, "JSON.stringify(window.nativeContactsEvidence)")
                        result.put("contacts", JSONObject(JSONTokener(evidence).nextValue() as String))
                        InstrumentationRegistry.getInstrumentation().sendStatus(2, Bundle().apply {
                            putString("nativeArtifactName", "contacts-import-bridge.json")
                            putString("nativeArtifactBase64", Base64.encodeToString(result.toString().toByteArray(), Base64.NO_WRAP))
                        })
                    }
                    if (descriptor.has("smsRole")) {
                        val evidence = evaluate(scenario, "JSON.stringify(window.nativeSmsEvidence)")
                        result.put("sms", JSONObject(JSONTokener(evidence).nextValue() as String))
                        InstrumentationRegistry.getInstrumentation().sendStatus(2, Bundle().apply {
                            putString("nativeArtifactName", "sms-${descriptor.getString("smsRole")}.json")
                            putString("nativeArtifactBase64", Base64.encodeToString(result.toString().toByteArray(), Base64.NO_WRAP))
                        })
                    }
                    if (descriptor.has("systemStage")) {
                        val evidence = evaluate(scenario, "JSON.stringify(window.nativeSystemEvidence)")
                        result.put("system", JSONObject(JSONTokener(evidence).nextValue() as String))
                        InstrumentationRegistry.getInstrumentation().sendStatus(2, Bundle().apply {
                            putString("nativeArtifactName", "system-controls-${descriptor.getString("systemStage")}-bridge.json")
                            putString("nativeArtifactBase64", Base64.encodeToString(result.toString().toByteArray(), Base64.NO_WRAP))
                        })
                    }
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
                    verifyResult(result)
                    return
                }
                Thread.sleep(30)
            }
            fail("Native contract timed out: $descriptor")
        }
    }
}
