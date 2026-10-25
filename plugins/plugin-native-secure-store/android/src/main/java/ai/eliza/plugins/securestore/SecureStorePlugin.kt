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

@CapacitorPlugin(name = "ElizaSecureStore")
class SecureStorePlugin : Plugin() {
    private val store: NativeSecureStore
        get() = NativeSecureStore(context)
    private val maximumValueBytes = NativeSecureStore.MAXIMUM_VALUE_BYTES

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
        try {
            store.set(key, value)
            call.resolve(JSObject().apply { put("ok", true) })
        } catch (_: Exception) {
            // error-policy:J1 native write errors cross the bridge without secret-bearing details.
            call.resolve(errorResult("native_error", "Android Keystore operation failed."))
        }
    }

    @PluginMethod
    fun remove(call: PluginCall) {
        val key = validatedKey(call) ?: return
        try {
            val deleted = store.remove(key)
            call.resolve(JSObject().apply {
                put("ok", true)
                put("deleted", deleted)
            })
        } catch (_: Exception) {
            // error-policy:J1 failed deletion is reported explicitly without exposing stored values.
            call.resolve(errorResult("native_error", "Android Keystore operation failed."))
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
