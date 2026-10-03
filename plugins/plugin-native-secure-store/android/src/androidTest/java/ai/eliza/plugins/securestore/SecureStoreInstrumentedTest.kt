/**
 * Exercises the production bridge against Android Keystore and AtomicFile in an isolated test UID.
 * Only the JavaScript reply transport is intercepted. Fixtures never read or overwrite
 * the installed Eliza application's credentials; teardown removes test-owned ciphertexts.
 */
package ai.eliza.plugins.securestore

import android.content.Intent
import android.util.AtomicFile
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import java.io.File
import java.security.KeyStore
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SecureStoreInstrumentedTest {
    private lateinit var scenario: ActivityScenario<SecureStoreTestActivity>
    private val first = "session.device_auth"
    private val second = "session.steward_token"
    private val directory: File
        get() = File(InstrumentationRegistry.getInstrumentation().targetContext.noBackupFilesDir, "eliza-secure-store")
    private fun file(key: String) = File(directory, key.replace('.', '_') + ".enc")

    @Before fun prepare() {
        clearFixtures()
        scenario = ActivityScenario.launch(SecureStoreTestActivity::class.java)
    }

    @After fun cleanup() {
        if (::scenario.isInitialized) scenario.close()
        clearFixtures()
    }

    private fun clearFixtures() {
        for (key in listOf(first, second, "runtime.active_server", "runtime.agent_profiles")) AtomicFile(file(key)).delete()
    }

    private fun call(method: String, key: String? = null, value: String? = null): JSObject {
        lateinit var result: JSObject
        scenario.onActivity { activity ->
            result = invoke(activity.bridge.getPlugin("ElizaSecureStore").instance as SecureStorePlugin, method, key, value)
        }
        return result
    }

    private fun invoke(plugin: SecureStorePlugin, method: String, key: String? = null, value: String? = null): JSObject {
        val data = JSObject().apply { if (key != null) put("key", key); if (value != null) put("value", value) }
        var result: JSObject? = null
        var settlements = 0
        val reply = object : PluginCall(null, "ElizaSecureStore", "secure-store-test", method, data) {
            override fun resolve(data: JSObject) { result = data; settlements++ }
        }
        when (method) {
            "get" -> plugin.get(reply)
            "set" -> plugin.set(reply)
            "remove" -> plugin.remove(reply)
            "status" -> plugin.status(reply)
            else -> error("Unknown harness operation")
        }
        assertEquals("Each synchronous bridge call must settle once", 1, settlements)
        return requireNotNull(result)
    }

    private fun set(key: String, value: String) { assertTrue(call("set", key, value).getBoolean("ok")) }

    @Test fun completeUnicodeValueSurvivesActivityRecreation_andOversizeWriteLeavesItIntact() {
        val value = "🙂".repeat(65_536)
        set(first, value)
        scenario.recreate()
        assertEquals(value, call("get", first).getString("value"))
        val oversized = call("set", first, value + "x")
        assertFalse(oversized.getBoolean("ok"))
        assertEquals("invalid_input", oversized.getString("error"))
        assertEquals(value, call("get", first).getString("value"))
    }

    @Test fun committedLegacyBackupIsRecoveredBeforeMissingValueIsReported() {
        val value = "test-only recovery value"
        set(first, value)
        val base = file(first)
        val backup = File(base.path + ".bak")
        assertTrue(base.renameTo(backup))
        val recovered = call("get", first)
        assertTrue("A committed AtomicFile backup must remain readable: $recovered", recovered.getBoolean("ok"))
        assertEquals(value, recovered.getString("value"))
        assertTrue(base.exists())
        assertFalse(backup.exists())
    }

    @Test fun removeReportsAndDeletesBackupAndInterruptedWriteArtifacts() {
        set(first, "test-only remove value")
        val base = file(first)
        val backup = File(base.path + ".bak")
        val pending = File(base.path + ".new")
        assertTrue(base.renameTo(backup))
        pending.writeText("incomplete test-owned write")
        val removed = call("remove", first)
        assertTrue(removed.getBoolean("ok"))
        assertTrue("Removal must report existing AtomicFile artifacts", removed.getBoolean("deleted"))
        assertFalse(base.exists()); assertFalse(backup.exists()); assertFalse(pending.exists())
        assertEquals("not_found", call("get", first).getString("error"))
        assertFalse(call("remove", first).getBoolean("deleted"))
    }

    @Test fun writesAreRandomized_andTheRealKeystoreKeyCannotBeExported() {
        val value = "test-only repeated plaintext"
        set(first, value)
        val previous = file(first).readBytes()
        set(first, value)
        assertFalse(previous.contentEquals(file(first).readBytes()))
        assertEquals(value, call("get", first).getString("value"))
        assertFalse(file(first).readText().contains(value))
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        assertNull(store.getKey("ai.elizaos.secure-store.v1", null).encoded)
    }

    @Test fun wrongLogicalKeyAndMalformedCiphertextReturnSanitizedFailures() {
        val marker = "test-only non-secret failure marker"
        set(first, marker)
        file(first).copyTo(file(second), overwrite = true)
        val wrongKey = call("get", second)
        assertFalse(wrongKey.getBoolean("ok"))
        assertEquals("native_error", wrongKey.getString("error"))
        assertFalse(wrongKey.toString().contains(marker))
        file(first).writeText(marker)
        val malformed = call("get", first)
        assertFalse(malformed.getBoolean("ok"))
        assertEquals("native_error", malformed.getString("error"))
        assertFalse(malformed.toString().contains(marker))
    }

    @Test fun missingAndUnallowlistedKeysRemainDistinctFromNativeAvailability() {
        assertTrue(call("status").getBoolean("available"))
        assertEquals("not_found", call("get", first).getString("error"))
        assertEquals("invalid_input", call("set", "../untrusted", "test-only").getString("error"))
        assertEquals("invalid_input", call("set", first, "").getString("error"))
        assertEquals("not_found", call("get", first).getString("error"))
    }
    @Test fun concurrentBridgeInstancesPreserveBothValuesDuringColdKeystoreCreation() {
        lateinit var firstPlugin: SecureStorePlugin
        scenario.onActivity { firstPlugin = it.bridge.getPlugin("ElizaSecureStore").instance as SecureStorePlugin }
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val intent = Intent(context, SecureStoreTestActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK)
        ActivityScenario.launch<SecureStoreTestActivity>(intent).use { other ->
            lateinit var secondPlugin: SecureStorePlugin
            other.onActivity { secondPlugin = it.bridge.getPlugin("ElizaSecureStore").instance as SecureStorePlugin }
            val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            store.deleteEntry("ai.elizaos.secure-store.v1")
            val start = CountDownLatch(1)
            val executor = Executors.newFixedThreadPool(2)
            val firstValue = "test-only first concurrent value".repeat(1000)
            val secondValue = "test-only second concurrent value".repeat(1000)
            try {
                val left = executor.submit<JSObject> { start.await(); invoke(firstPlugin, "set", first, firstValue) }
                val right = executor.submit<JSObject> { start.await(); invoke(secondPlugin, "set", second, secondValue) }
                start.countDown()
                assertTrue("First concurrent write must succeed", left.get(30, TimeUnit.SECONDS).getBoolean("ok"))
                assertTrue("Second concurrent write must succeed", right.get(30, TimeUnit.SECONDS).getBoolean("ok"))
                assertTrue("First complete value must survive concurrent key creation", invoke(firstPlugin, "get", first).getString("value") == firstValue)
                assertTrue("Second complete value must survive concurrent key creation", invoke(secondPlugin, "get", second).getString("value") == secondValue)
            } finally {
                start.countDown()
                executor.shutdownNow()
            }
        }
    }

}
