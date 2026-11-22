// spec/os/android/secureStore.md, "Story: Persist a value without losing a newer edit"
package ai.eliza.plugins.securestore

import android.util.AtomicFile
import ai.eliza.plugins.securestore.nativeonly.NativeSecureStore
import ai.eliza.plugins.securestore.nativeonly.SecureSlotPolicy
import ai.eliza.plugins.securestore.nativeonly.SecureSlotPolicy.Caller
import ai.eliza.plugins.securestore.nativeonly.SecureSlotPolicy.ExchangeOutcome
import ai.eliza.plugins.securestore.nativeonly.SecureSlots
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SecureStoreInstrumentedTest {
    private lateinit var scenario: ActivityScenario<SecureStoreTestActivity>
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val first = "test.secure-store.first"
    private val second = "test.secure-store.second"
    private val legacy = "session.device_auth"
    private val scratch = mutableListOf<Pair<File, String>>()

    @Before fun prepare() {
        clearFixtures()
        scenario = ActivityScenario.launch(SecureStoreTestActivity::class.java)
    }

    @After fun cleanup() {
        if (::scenario.isInitialized) scenario.close()
        clearFixtures()
        val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        for ((directory, alias) in scratch) {
            directory.deleteRecursively()
            keys.deleteEntry(alias)
        }
    }

    private fun clearFixtures() {
        val host = SecureSlots.forHost(context)
        for (key in listOf(first, second)) host.remove(Caller.NativeCaller, key)
        for (key in listOf(legacy, "native.clock_device")) AtomicFile(legacyFile(key)).delete()
    }

    private fun legacyFile(key: String) = File(context.noBackupFilesDir, "eliza-secure-store/" + key.replace('.', '_') + ".enc")

    private fun slotFile(directory: File, name: String): File {
        val digest = MessageDigest.getInstance("SHA-256").digest(name.toByteArray(Charsets.UTF_8))
        return File(directory, digest.joinToString("") { "%02x".format(it.toInt() and 255) })
    }

    private fun hostFile(name: String) = slotFile(File(context.noBackupFilesDir, SecureSlots.DIRECTORY), name)

    private fun scratchSlots(policy: Map<String, Any>): Pair<File, () -> SecureSlots> {
        val directory = File(context.noBackupFilesDir, "secure-slots-test-" + UUID.randomUUID())
        val alias = "eliza.secure-slots-test." + UUID.randomUUID()
        scratch += directory to alias
        val parsed = SecureSlotPolicy.parse(policy)
        return directory to { SecureSlots(directory, alias, parsed) }
    }

    private fun call(method: String, key: String? = null, value: String? = null, expected: String? = null): JSObject {
        lateinit var result: JSObject
        scenario.onActivity { activity ->
            result = invoke(activity.bridge.getPlugin("ElizaSecureStore").instance as SecureStorePlugin, method, key, value, expected)
        }
        return result
    }

    private fun invoke(plugin: SecureStorePlugin, method: String, key: String? = null, value: String? = null, expected: String? = null): JSObject {
        val data = JSObject().apply {
            if (key != null) put("key", key)
            if (value != null) put("value", value)
            if (expected != null) put("expected", expected)
        }
        var result: JSObject? = null
        var settlements = 0
        val reply = object : PluginCall(null, "ElizaSecureStore", "secure-store-test", method, data) {
            override fun resolve(data: JSObject) { result = data; settlements++ }
        }
        when (method) {
            "get" -> plugin.get(reply)
            "set" -> plugin.set(reply)
            "remove" -> plugin.remove(reply)
            "compareAndExchange" -> plugin.compareAndExchange(reply)
            "status" -> plugin.status(reply)
            else -> error("Unknown harness operation")
        }
        assertEquals("Each synchronous bridge call must settle once", 1, settlements)
        return requireNotNull(result)
    }

    private class GuardedPlugin : SecureStorePlugin() {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        private val intent = AtomicLong()
        private val first = AtomicBoolean(true)
        override fun useCredentialWorker(key: String) = true
        override fun reserveCredentialMutation(key: String): Runnable {
            val mine = intent.incrementAndGet()
            return Runnable { check(intent.get() == mine) { "Credential intent changed" } }
        }
        override fun <T> mutateCredential(key: String, value: String?, guard: Runnable, effect: NativeSecureStore.Effect<T>): T {
            if (first.compareAndSet(true, false)) {
                entered.countDown()
                check(release.await(5, TimeUnit.SECONDS)) { "Host retirement wait timed out" }
            }
            return super.mutateCredential(key, value, guard, effect)
        }
        fun closeBridge() { handleOnDestroy() }
        fun reservations() = intent.get()
    }

    @Test fun writtenValueReadsBackAcrossRecreationAndIsEncryptedUnderTheSlotDigest() {
        val value = "\"" + "🙂".repeat(1024) + "\""
        val written = call("set", first, value)
        assertTrue(written.getBoolean("ok"))
        assertEquals("Written", written.getString("outcome"))
        assertFalse(hostFile(first).readText(Charsets.ISO_8859_1).contains("🙂"))
        scenario.recreate()
        assertEquals(value, call("get", first).getString("value"))
        val removed = call("remove", first)
        assertEquals("Removed", removed.getString("outcome"))
        assertEquals("not_found", call("get", first).getString("error"))
    }

    @Test fun appViewIsRefusedNativeOnlyDelegationMalformedAndEmptyRequests() {
        for (name in listOf("sign-in", "sign-in:authority:credential", "deep-links:receipt", "task-data-key:v1:task", "native.clock_device",
            "cloud-delegation:grant", "", "x".repeat(1025))) {
            for (method in listOf("get", "set", "remove")) {
                val answer = call(method, name, "{\"fixture\":true}")
                assertFalse(answer.getBoolean("ok"))
                assertEquals("denied", answer.getString("error"))
            }
            if (name.isNotEmpty() && name.length <= SecureSlotPolicy.NAME_LIMIT) assertFalse(hostFile(name).exists())
        }
        assertEquals("Refused", call("set", first, "").getString("outcome"))
        assertEquals("Refused", call("set", first, "not json").getString("outcome"))
        assertEquals("Refused", call("compareAndExchange", first, "{}").getString("outcome"))
        assertEquals("not_found", call("get", first).getString("error"))
        assertTrue(call("set", "x".repeat(1024), "1").getBoolean("ok"))
        assertTrue(call("remove", "x".repeat(1024)).getBoolean("ok"))
    }

    @Test fun nativeCallerReachesNativeOnlySlotsButNeverDelegationSlots() {
        val (_, open) = scratchSlots(mapOf())
        val slots = open()
        assertEquals(ExchangeOutcome.Written, slots.write(Caller.NativeCaller, "sign-in:authority:credential", "{\"v\":1}"))
        assertEquals("{\"v\":1}", (slots.read(Caller.NativeCaller, "sign-in:authority:credential") as SecureSlots.Present).value())
        assertTrue(slots.read(Caller.RendererCaller, "sign-in:authority:credential") is SecureSlots.Refused)
        assertEquals(ExchangeOutcome.Refused, slots.write(Caller.NativeCaller, "cloud-delegation:grant", "{}"))
        assertEquals(ExchangeOutcome.Removed, slots.remove(Caller.NativeCaller, "sign-in:authority:credential"))
    }

    @Test fun exchangeChangesOnlyAnExchangeableSlotHoldingExactlyTheExpectedText() {
        val (_, open) = scratchSlots(mapOf("slots" to listOf(
            mapOf("pattern" to "draft:.*", "access" to "exchangeable", "limit" to 64),
            mapOf("pattern" to "notes:.*", "access" to "writable", "limit" to 64))))
        val slots = open()
        val draft = "draft:one"
        assertEquals(ExchangeOutcome.Written, slots.compareAndExchange(Caller.RendererCaller, draft, null, "{\"n\":1}"))
        assertEquals(ExchangeOutcome.Conflict, slots.compareAndExchange(Caller.RendererCaller, draft, null, "{\"n\":2}"))
        assertEquals(ExchangeOutcome.Conflict, slots.compareAndExchange(Caller.RendererCaller, draft, "{\"n\": 1}", "{\"n\":2}"))
        assertEquals("{\"n\":1}", (slots.read(Caller.RendererCaller, draft) as SecureSlots.Present).value())
        assertEquals(ExchangeOutcome.Written, slots.compareAndExchange(Caller.RendererCaller, draft, "{\"n\":1}", "{\"n\":2}"))
        assertEquals(ExchangeOutcome.Removed, slots.compareAndExchange(Caller.RendererCaller, draft, "{\"n\":2}", null))
        assertTrue(slots.read(Caller.RendererCaller, draft) is SecureSlots.Absent)
        assertEquals(ExchangeOutcome.Refused, slots.compareAndExchange(Caller.RendererCaller, "notes:one", null, "{}"))
        assertEquals(ExchangeOutcome.Written, slots.write(Caller.RendererCaller, "notes:one", "{}"))
    }

    @Test fun aboveTheLimitAValueMayOnlyShrinkWhatAnOlderLargerLimitStored() {
        val (directory, open) = scratchSlots(mapOf("slots" to listOf(mapOf("pattern" to "draft", "access" to "exchangeable", "limit" to 64))))
        val alias = scratch.last().second
        val lowered = SecureSlots(directory, alias, SecureSlotPolicy.parse(mapOf("slots" to listOf(
            mapOf("pattern" to "draft", "access" to "exchangeable", "limit" to 16, "retained" to 64)))))
        val forty = "\"" + "a".repeat(38) + "\""
        val thirty = "\"" + "b".repeat(28) + "\""
        assertEquals(ExchangeOutcome.CapacityRefused, lowered.write(Caller.RendererCaller, "draft", thirty))
        assertEquals(ExchangeOutcome.Written, open().write(Caller.RendererCaller, "draft", forty))
        assertEquals(forty, (lowered.read(Caller.RendererCaller, "draft") as SecureSlots.Present).value())
        assertEquals(ExchangeOutcome.CapacityRefused, lowered.write(Caller.RendererCaller, "draft", "\"" + "c".repeat(48) + "\""))
        assertEquals(ExchangeOutcome.Written, lowered.write(Caller.RendererCaller, "draft", thirty))
        assertEquals(ExchangeOutcome.CapacityRefused, lowered.write(Caller.RendererCaller, "draft", forty))
        assertEquals(ExchangeOutcome.CapacityRefused, lowered.write(Caller.RendererCaller, "draft", "\"" + "d".repeat(80) + "\""))
    }

    @Test fun unreadableSlotIsReportedKeptAndNeverExchangedOrReKeyed() {
        val (directory, open) = scratchSlots(mapOf("slots" to listOf(mapOf("pattern" to "draft", "access" to "exchangeable", "limit" to 16, "retained" to 32))))
        val alias = scratch.last().second
        val slots = open()
        assertEquals(ExchangeOutcome.Written, slots.write(Caller.RendererCaller, "draft", "{\"n\":1}"))
        val file = slotFile(directory, "draft")
        file.writeBytes(byteArrayOf(1, 12) + ByteArray(40))
        val corrupt = file.readBytes()
        assertTrue(slots.read(Caller.RendererCaller, "draft") is SecureSlots.Unreadable)
        assertEquals(ExchangeOutcome.Failed, slots.compareAndExchange(Caller.RendererCaller, "draft", null, "{\"n\":2}"))
        assertEquals(ExchangeOutcome.Failed, slots.write(Caller.RendererCaller, "draft", "\"" + "e".repeat(20) + "\""))
        assertArrayEquals(corrupt, file.readBytes())
        val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        keys.deleteEntry(alias)
        assertTrue(slots.read(Caller.RendererCaller, "draft") is SecureSlots.Unreadable)
        assertFalse("A read must never create a replacement key", keys.containsAlias(alias))
    }

    @Test fun removalIsAcknowledgedOnlyWhenTheFileBackupAndStagedSiblingAreGone() {
        assertTrue(call("set", first, "{\"remove\":true}").getBoolean("ok"))
        val base = hostFile(first)
        val backup = File(base.path + ".bak")
        val staged = File(base.path + ".new")
        assertTrue(base.renameTo(backup))
        staged.writeText("incomplete test-owned write")
        assertEquals("{\"remove\":true}", call("get", first).getString("value"))
        assertEquals("Removed", call("remove", first).getString("outcome"))
        assertFalse(base.exists()); assertFalse(backup.exists()); assertFalse(staged.exists())
        assertEquals("not_found", call("get", first).getString("error"))
    }

    @Test fun newerRemoveAndSetFenceOlderQueuedMutationsBeforeKeystoreEffects() {
        val host = SecureSlots.forHost(context)
        for (olderMethod in listOf("set", "remove")) {
            assertEquals(ExchangeOutcome.Written, host.write(Caller.NativeCaller, second, "\"original\""))
            val plugin = GuardedPlugin()
            scenario.onActivity { plugin.setBridge(it.bridge) }
            val oldDone = CountDownLatch(1)
            val newDone = CountDownLatch(1)
            var oldResult: JSObject? = null
            var newResult: JSObject? = null
            fun dispatch(method: String, result: (JSObject) -> Unit) {
                val data = JSObject().put("key", second).put("value", "\"replacement\"")
                val call = object : PluginCall(null, "ElizaSecureStore", "guarded-test", method, data) {
                    override fun resolve(data: JSObject) { result(data) }
                }
                if (method == "set") plugin.set(call) else plugin.remove(call)
            }
            try {
                dispatch(olderMethod) { oldResult = it; oldDone.countDown() }
                assertTrue("first mutation entered the host wait", plugin.entered.await(5, TimeUnit.SECONDS))
                val newerMethod = if (olderMethod == "set") "remove" else "set"
                dispatch(newerMethod) { newResult = it; newDone.countDown() }
                plugin.release.countDown()
                assertTrue(oldDone.await(5, TimeUnit.SECONDS)); assertTrue(newDone.await(5, TimeUnit.SECONDS))
                assertEquals("Failed", requireNotNull(oldResult).getString("outcome"))
                assertTrue(requireNotNull(newResult).getBoolean("ok"))
                val now = host.read(Caller.NativeCaller, second)
                if (newerMethod == "set") assertEquals("\"replacement\"", (now as SecureSlots.Present).value())
                else assertTrue(now is SecureSlots.Absent)
            } finally { plugin.release.countDown(); plugin.closeBridge() }
        }
    }

    @Test fun closedBridgeCannotReserveAnotherCredentialIntent() {
        val plugin = GuardedPlugin()
        scenario.onActivity { plugin.setBridge(it.bridge) }
        plugin.closeBridge()
        var result: JSObject? = null
        val call = object : PluginCall(null, "ElizaSecureStore", "closed-test", "remove", JSObject().put("key", second)) {
            override fun resolve(data: JSObject) { result = data }
        }
        plugin.remove(call)
        assertEquals("native_error", requireNotNull(result).getString("error"))
        assertEquals(0L, plugin.reservations())
    }

    @Test fun concurrentBridgeInstancesPreserveBothValues() {
        lateinit var firstPlugin: SecureStorePlugin
        scenario.onActivity { firstPlugin = it.bridge.getPlugin("ElizaSecureStore").instance as SecureStorePlugin }
        val secondPlugin = SecureStorePlugin()
        scenario.onActivity { secondPlugin.setBridge(it.bridge) }
        val start = CountDownLatch(1)
        val executor = Executors.newFixedThreadPool(2)
        val firstValue = "\"" + "first concurrent value ".repeat(1000) + "\""
        val secondValue = "\"" + "second concurrent value ".repeat(1000) + "\""
        try {
            val left = executor.submit<JSObject> { start.await(); invoke(firstPlugin, "set", first, firstValue) }
            val right = executor.submit<JSObject> { start.await(); invoke(secondPlugin, "set", second, secondValue) }
            start.countDown()
            assertTrue(left.get(30, TimeUnit.SECONDS).getBoolean("ok"))
            assertTrue(right.get(30, TimeUnit.SECONDS).getBoolean("ok"))
            assertEquals(firstValue, invoke(firstPlugin, "get", first).getString("value"))
            assertEquals(secondValue, invoke(secondPlugin, "get", second).getString("value"))
        } finally {
            start.countDown()
            executor.shutdownNow()
        }
    }

    @Test fun nativeSnapshotsFenceMutationAcrossInstances() {
        val native = NativeSecureStore(context)
        native.set(legacy, "test-only initial owner")
        val original = native.snapshot()
        assertEquals("test-only initial owner", original.require(legacy))
        native.assertCurrent(original)
        native.set(legacy, "test-only replacement session")
        assertTrue(NativeSecureStore(context).generation > original.generation)
        try { native.assertCurrent(original); fail("Mutation retained stale snapshot") }
        catch (_: SecurityException) {}
        val current = native.snapshot()
        assertTrue(NativeSecureStore(context).remove(legacy))
        var dispatched = false
        try { native.withSnapshot(current) { dispatched = true; null }; fail("Stale effect dispatched") }
        catch (_: SecurityException) {}
        assertFalse(dispatched)
        assertNull(native.snapshot().get(legacy))
    }

    @Test fun clockIdentityIsStableNativeOnlyAndNeverRotatesMalformedExistingState() {
        val native = NativeSecureStore(context)
        val identity = native.ensureClockDevice()
        assertTrue(identity.installationId.matches(Regex("[a-f0-9-]{36}")))
        assertTrue(identity.deviceKey.matches(Regex("[a-f0-9]{64}")))
        val reopened = NativeSecureStore(context).ensureClockDevice()
        assertEquals(identity.installationId, reopened.installationId)
        assertEquals(identity.deviceKey, reopened.deviceKey)
        assertFalse(legacyFile("native.clock_device").readText().contains(identity.deviceKey))
        for (method in listOf("get", "set", "remove"))
            assertEquals("denied", call(method, "native.clock_device", "{\"replacement\":true}").getString("error"))
        val pending = File(legacyFile("native.clock_device").path + ".new")
        AtomicFile(legacyFile("native.clock_device")).delete()
        pending.writeText("test-only interrupted ciphertext")
        try { native.ensureClockDevice(); fail("Interrupted identity replaced silently") }
        catch (_: IllegalStateException) {}
        assertTrue(pending.exists())
        assertFalse(legacyFile("native.clock_device").exists())
        pending.delete()
    }
}
