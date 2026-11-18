// spec/os/android/secureStore.md, "The app view names only slots its consumer policy opens to it, and never a delegation slot"; spec/os/android/secureStore.md, "A compare-and-exchange changes a slot only when it holds exactly the expected value"; spec/os/android/secureStore.md, "A write is acknowledged only after it reads back exactly, and a removal only after every file of the slot is gone"; spec/os/android/secureStore.md, "Every mutation that touches the files is answered"
package ai.eliza.plugins.securestore

import ai.eliza.plugins.securestore.nativeonly.NativeSecureStore
import ai.eliza.plugins.securestore.nativeonly.SecureSlotPolicy.Caller
import ai.eliza.plugins.securestore.nativeonly.SecureSlotPolicy.ExchangeOutcome
import ai.eliza.plugins.securestore.nativeonly.SecureSlots
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.Executors

@CapacitorPlugin(name = "ElizaSecureStore")
open class SecureStorePlugin : Plugin() {
    private val mutationWorker = Executors.newSingleThreadExecutor()
    @Volatile private var closed = false

    protected open fun reserveCredentialMutation(key: String): Runnable = Runnable { }

    protected open fun useCredentialWorker(key: String): Boolean = false

    @Throws(Exception::class)
    protected open fun <T> mutateCredential(key: String, value: String?, guard: Runnable, effect: NativeSecureStore.Effect<T>): T {
        guard.run()
        return effect.run()
    }

    private fun slots(call: PluginCall): SecureSlots? = try {
        SecureSlots.forHost(context)
    } catch (_: Exception) {
        call.resolve(failure("unavailable"))
        null
    }

    private fun mutate(call: PluginCall, key: String, value: String?, exchange: (SecureSlots) -> ExchangeOutcome) {
        val slots = slots(call) ?: return
        var touched = false
        val settle = { failed: Exception? ->
            if (failed != null) call.resolve(answer(if (touched) ExchangeOutcome.Unconfirmed else ExchangeOutcome.Failed))
        }
        try {
            if (closed) throw IllegalStateException("Secure-store bridge closed")
            val owner = reserveCredentialMutation(key)
            val guard = Runnable {
                if (closed) throw IllegalStateException("Secure-store bridge closed")
                owner.run()
            }
            val mutation = Runnable {
                try {
                    val outcome = mutateCredential(key, value, guard, NativeSecureStore.Effect {
                        guard.run()
                        touched = true
                        exchange(slots)
                    })
                    call.resolve(answer(outcome))
                } catch (failed: Exception) {
                    settle(failed)
                }
            }
            if (useCredentialWorker(key)) mutationWorker.execute(mutation) else mutation.run()
        } catch (failed: Exception) {
            settle(failed)
        }
    }

    override fun handleOnDestroy() {
        closed = true
        mutationWorker.shutdown()
        super.handleOnDestroy()
    }

    @PluginMethod
    fun get(call: PluginCall) {
        val slots = slots(call) ?: return
        call.resolve(when (val reading = slots.read(Caller.RendererCaller, call.getString("key"))) {
            is SecureSlots.Present -> JSObject().apply {
                put("ok", true)
                put("value", reading.value())
            }
            is SecureSlots.Absent -> failure("not_found")
            is SecureSlots.Unreadable -> failure("unreadable")
            is SecureSlots.Refused -> failure("denied")
            else -> failure("native_error")
        })
    }

    @PluginMethod
    fun set(call: PluginCall) {
        val key = call.getString("key") ?: ""
        val value = call.getString("value") ?: ""
        mutate(call, key, value) { it.write(Caller.RendererCaller, key, value) }
    }

    @PluginMethod
    fun remove(call: PluginCall) {
        val key = call.getString("key") ?: ""
        mutate(call, key, null) { it.remove(Caller.RendererCaller, key) }
    }

    @PluginMethod
    fun compareAndExchange(call: PluginCall) {
        val key = call.getString("key") ?: ""
        val expected = call.getString("expected")
        val value = call.getString("value")
        mutate(call, key, value) { it.compareAndExchange(Caller.RendererCaller, key, expected, value) }
    }

    @PluginMethod
    fun status(call: PluginCall) {
        val slots = slots(call) ?: return
        try {
            slots.ensureAvailable()
            call.resolve(JSObject().apply {
                put("ok", true)
                put("available", true)
                put("backend", "android_keystore")
                put("accessibility", "credential_encrypted_device_only")
                put("synchronized", false)
                put("accessGroup", "app_only")
            })
        } catch (_: Exception) {
            call.resolve(failure("unavailable").apply {
                put("available", false)
                put("backend", "unavailable")
                put("accessibility", "unavailable")
                put("synchronized", false)
                put("accessGroup", "app_only")
            })
        }
    }

    private fun answer(outcome: ExchangeOutcome): JSObject = when (outcome) {
        ExchangeOutcome.Written, ExchangeOutcome.Removed -> JSObject().apply {
            put("ok", true)
            put("outcome", outcome.name)
        }
        ExchangeOutcome.Conflict -> failure("conflict", outcome)
        ExchangeOutcome.CapacityRefused -> failure("storage_full", outcome)
        ExchangeOutcome.Refused -> failure("denied", outcome)
        ExchangeOutcome.Failed -> failure("native_error", outcome)
        ExchangeOutcome.Unconfirmed -> failure("unconfirmed", outcome)
    }

    private fun failure(code: String, outcome: ExchangeOutcome? = null): JSObject = JSObject().apply {
        put("ok", false)
        put("error", code)
        if (outcome != null) put("outcome", outcome.name)
    }
}
