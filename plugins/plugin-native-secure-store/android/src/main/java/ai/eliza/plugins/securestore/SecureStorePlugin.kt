/**
 * Provides device-bound Android credential storage to the Capacitor renderer.
 * Values are allowlisted, AES-GCM encrypted with a non-exportable Keystore key,
 * and atomically persisted outside Android Backup. Bridge instances in the app
 * process share admission for key creation and ciphertext operations.
 */
package ai.eliza.plugins.securestore

import ai.eliza.plugins.securestore.nativeonly.NativeSecureStore
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

@CapacitorPlugin(name = "ElizaSecureStore")
open class SecureStorePlugin : Plugin() {
    private val store: NativeSecureStore
        get() = NativeSecureStore(context)
    private val maximumValueBytes = NativeSecureStore.MAXIMUM_VALUE_BYTES
    private val mutationWorker = Executors.newSingleThreadExecutor()
    @Volatile private var closed = false

    /** Hosts reserve their existing credential intent before work enters the queue. */
    protected open fun reserveCredentialMutation(key: String): Runnable = Runnable { }

    /** Only a host-bound resident credential needs asynchronous service retirement. */
    protected open fun useCredentialWorker(key: String): Boolean = false

    /** Called before NativeSecureStore acquires its own lock. Never call a host from inside it. */
    @Throws(Exception::class)
    protected open fun <T> mutateCredential(
        key: String, value: String?, guard: Runnable, effect: NativeSecureStore.Effect<T>,
    ): T {
        guard.run()
        return effect.run()
    }

    private fun enqueueMutation(call: PluginCall, key: String, action: (Runnable) -> Unit) {
        try {
            if (closed) throw IllegalStateException("Secure-store bridge closed")
            val owner = reserveCredentialMutation(key)
            val guard = Runnable {
                if (closed) throw IllegalStateException("Secure-store bridge closed")
                owner.run()
            }
            val mutation = Runnable {
                try { guard.run(); action(guard) }
                catch (_: Exception) {
                    // error-policy:J1 Lifecycle/admission errors carry no credential details.
                    call.resolve(errorResult("native_error", "Android Keystore operation failed."))
                }
            }
            if (useCredentialWorker(key)) mutationWorker.execute(mutation) else mutation.run()
        } catch (_: RejectedExecutionException) {
            // error-policy:J1 Closed native bridges never accept another queued write.
            call.resolve(errorResult("native_error", "Android Keystore operation failed."))
        } catch (_: Exception) {
            // error-policy:J1 Host admission may reject before any store operation.
            call.resolve(errorResult("native_error", "Android Keystore operation failed."))
        }
    }

    override fun handleOnDestroy() {
        closed = true
        mutationWorker.shutdown()
        super.handleOnDestroy()
    }

    @PluginMethod
    fun get(call: PluginCall) {
        val key = validatedKey(call) ?: return
        try {
            val value = store.get(key)
            if (value == null) {
                call.resolve(errorResult("not_found", "Secure value was not found."))
            } else {
                call.resolve(JSObject().apply {
                    put("ok", true)
                    put("value", value)
                })
            }
        } catch (_: Exception) {
            // error-policy:J1 expose a sanitized native failure, never credential-bearing exception text.
            call.resolve(errorResult("native_error", "Android Keystore operation failed."))
        }
    }

    @PluginMethod
    fun set(call: PluginCall) {
        val key = validatedKey(call) ?: return
        val value = call.getString("value")
        val valueBytes = value?.toByteArray(Charsets.UTF_8)
        if (value.isNullOrEmpty() || valueBytes == null || valueBytes.size > maximumValueBytes) {
            call.resolve(errorResult("invalid_input", "Secure value must be non-empty and at most $maximumValueBytes UTF-8 bytes."))
            return
        }
        enqueueMutation(call, key) { guard ->
            mutateCredential(key, value, guard, NativeSecureStore.Effect {
                store.set(key, value)
                true
            })
            call.resolve(JSObject().apply { put("ok", true) })
        }
    }

    @PluginMethod
    fun remove(call: PluginCall) {
        val key = validatedKey(call) ?: return
        enqueueMutation(call, key) { guard ->
            val deleted = mutateCredential(key, null, guard, NativeSecureStore.Effect { store.remove(key) })
            call.resolve(JSObject().apply {
                put("ok", true)
                put("deleted", deleted)
            })
        }
    }

    @PluginMethod
    fun status(call: PluginCall) {
        try {
            store.ensureAvailable()
            call.resolve(
                JSObject().apply {
                    put("ok", true)
                    put("available", true)
                    put("backend", "android_keystore")
                    put("accessibility", "credential_encrypted_device_only")
                    put("synchronized", false)
                    put("accessGroup", "app_only")
                },
            )
        } catch (_: Exception) {
            // error-policy:J1 Keystore admission failure becomes an explicit unavailable result.
            call.resolve(
                errorResult("unavailable", "Android Keystore is unavailable on this device.").apply {
                    put("available", false)
                    put("backend", "unavailable")
                    put("accessibility", "unavailable")
                    put("synchronized", false)
                    put("accessGroup", "app_only")
                },
            )
        }
    }

    private fun validatedKey(call: PluginCall): String? {
        val key = call.getString("key")
        if (key == null || !NativeSecureStore.isAllowedKey(key)) {
            call.resolve(errorResult("invalid_input", "Secure-store key is not allowed."))
            return null
        }
        return key
    }

    private fun errorResult(code: String, message: String): JSObject = JSObject().apply {
        put("ok", false)
        put("error", code)
        put("message", message)
    }
}
