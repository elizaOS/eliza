// spec/os/android/secureStore.md, "A write is acknowledged only after it reads back exactly, and a removal only after every file of the slot is gone"
package ai.eliza.plugins.securestore

import android.os.Bundle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.getcapacitor.BridgeActivity
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** A real WebView -> Capacitor -> Android Keystore -> disk -> WebView round trip. */
class SecureStoreTestActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(SecureStorePlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}

@RunWith(AndroidJUnit4::class)
class SecureStoreBridgeInstrumentedTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val key = "test.secure-store.bridge"
    private val file: File
        get() {
            val digest = MessageDigest.getInstance("SHA-256").digest(key.toByteArray(Charsets.UTF_8))
            return File(File(context.noBackupFilesDir, "eliza-secure-slots"), digest.joinToString("") { "%02x".format(it.toInt() and 255) })
        }

    private fun evaluate(scenario: ActivityScenario<SecureStoreTestActivity>, script: String): String {
        val done = CountDownLatch(1)
        var result = "null"
        scenario.onActivity { activity ->
            activity.bridge.webView.evaluateJavascript(script) {
                result = it
                done.countDown()
            }
        }
        assertTrue("WebView evaluation timed out", done.await(10, TimeUnit.SECONDS))
        return result
    }

    private fun ready(scenario: ActivityScenario<SecureStoreTestActivity>) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
        while (System.nanoTime() < deadline) {
            if (evaluate(scenario, "Boolean(window.Capacitor && window.Capacitor.nativePromise)") == "true") return
            Thread.sleep(50)
        }
        fail("Capacitor did not initialize in the test WebView")
    }

    private fun call(scenario: ActivityScenario<SecureStoreTestActivity>, method: String, options: JSONObject = JSONObject()): JSONObject {
        evaluate(scenario, """
            window.testResult = null;
            window.Capacitor.nativePromise('ElizaSecureStore', '$method', $options)
              .then(value => window.testResult = JSON.stringify(value))
              .catch(error => window.testResult = JSON.stringify({bridgeError: String(error)}));
        """.trimIndent())
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (System.nanoTime() < deadline) {
            val result = evaluate(scenario, "window.testResult")
            if (result != "null") {
                val value = JSONObject(JSONTokener(result).nextValue() as String)
                assertFalse("Bridge rejected: $value", value.has("bridgeError"))
                return value
            }
            Thread.sleep(20)
        }
        throw AssertionError("Secure store $method did not resolve through Capacitor")
    }

    private fun options(value: String? = null, account: String = key) = JSONObject().apply {
        put("key", account)
        if (value != null) put("value", value)
    }

    @Test
    fun credentialsRoundTripAcrossActivityRecreationAndAreEncryptedOnDisk() {
        ActivityScenario.launch(SecureStoreTestActivity::class.java).use { scenario ->
            ready(scenario)
            try {
                val status = call(scenario, "status")
                assertTrue(status.getBoolean("available"))
                assertEquals("android_keystore", status.getString("backend"))
                val value = "\"test-only credential 🔐 ${System.nanoTime()}\""
                assertEquals("Written", call(scenario, "set", options(value)).getString("outcome"))
                val ciphertext = file.readBytes()
                assertFalse(ciphertext.toString(Charsets.UTF_8).contains("test-only"))
                assertEquals(value, call(scenario, "get", options()).getString("value"))
                scenario.recreate()
                ready(scenario)
                assertEquals(value, call(scenario, "get", options()).getString("value"))
                assertTrue(call(scenario, "set", options(value)).getBoolean("ok"))
                assertFalse("each write must use a fresh nonce", ciphertext.contentEquals(file.readBytes()))
                assertEquals("Removed", call(scenario, "remove", options()).getString("outcome"))
                assertFalse(file.exists())
                assertEquals("not_found", call(scenario, "get", options()).getString("error"))
                val exchange = call(scenario, "compareAndExchange", options(value).put("expected", JSONObject.NULL))
                assertEquals("Refused", exchange.getString("outcome"))
            } finally {
                call(scenario, "remove", options())
            }
        }
    }

    @Test
    fun invalidInputAndCorruptCiphertextFailWithoutReturningCredentials() {
        ActivityScenario.launch(SecureStoreTestActivity::class.java).use { scenario ->
            ready(scenario)
            try {
                for (invalid in listOf(options("{}", "sign-in:escape"), options("{}", "cloud-delegation:grant"), options(""), options("not json"))) {
                    assertEquals("denied", call(scenario, "set", invalid).getString("error"))
                }
                assertEquals("storage_full", call(scenario, "set", options("\"" + "é".repeat(131073) + "\"")).getString("error"))
                assertTrue(call(scenario, "set", options("\"test-only-secret\"")).getBoolean("ok"))
                file.writeText("corrupt ciphertext")
                val result = call(scenario, "get", options())
                assertFalse(result.getBoolean("ok"))
                assertEquals("unreadable", result.getString("error"))
                assertFalse(result.has("value"))
            } finally {
                call(scenario, "remove", options())
            }
        }
    }
}
