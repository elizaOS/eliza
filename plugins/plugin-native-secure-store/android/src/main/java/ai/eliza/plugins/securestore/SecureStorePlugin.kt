/**
 * Provides device-bound Android credential storage to the Capacitor renderer.
 * Values are allowlisted, AES-GCM encrypted with a non-exportable Keystore key,
 * and atomically persisted outside Android Backup. Bridge instances in the app
 * process share admission for key creation and ciphertext operations.
 */
package ai.eliza.plugins.securestore

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.nio.ByteBuffer
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@CapacitorPlugin(name = "ElizaSecureStore")
class SecureStorePlugin : Plugin() {
    private companion object {
        val lock = Any()
    }
    private val keyAlias = "ai.elizaos.secure-store.v1"
    private val maximumValueBytes = 256 * 1024
    private val allowedKeys = setOf(
        "session.device_auth",
        "session.steward_token",
        "runtime.active_server",
        "runtime.agent_profiles",
    )

    @PluginMethod
    fun get(call: PluginCall) {
        val key = validatedKey(call) ?: return
        try {
            val value = synchronized(lock) { readValue(key) }
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
            synchronized(lock) { writeValue(key, valueBytes) }
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
            val deleted = synchronized(lock) {
                val file = valueFile(key)
                val artifacts = valueArtifacts(file)
                val existed = artifacts.any { it.exists() }
                AtomicFile(file).delete()
                if (artifacts.any { it.exists() }) {
                    throw IllegalStateException("secure value deletion failed")
                }
                existed
            }
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
            synchronized(lock) { getOrCreateKey() }
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
        if (key == null || !allowedKeys.contains(key)) {
            call.resolve(errorResult("invalid_input", "Secure-store key is not allowed."))
            return null
        }
        return key
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(keyAlias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                keyAlias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    private fun writeValue(key: String, plaintext: ByteArray) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        cipher.updateAAD(key.toByteArray(Charsets.UTF_8))
        val encrypted = cipher.doFinal(plaintext)
        val iv = cipher.iv
        val payload = ByteBuffer.allocate(2 + iv.size + encrypted.size)
            .put(1)
            .put(iv.size.toByte())
            .put(iv)
            .put(encrypted)
            .array()
        val atomicFile = AtomicFile(valueFile(key))
        val stream = atomicFile.startWrite()
        try {
            stream.write(Base64.encode(payload, Base64.NO_WRAP))
            atomicFile.finishWrite(stream)
        } catch (error: Exception) {
            // error-policy:J2 restore the atomic write and preserve the original failure as cause.
            atomicFile.failWrite(stream)
            throw IllegalStateException("Atomic secure value write failed", error)
        }
    }

    private fun readValue(key: String): String? {
        val file = valueFile(key)
        // AtomicFile.openRead recovers the legacy backup even when the base is absent.
        if (!file.exists() && !legacyBackup(file).exists()) return null
        val maximumCiphertextBytes = maximumValueBytes * 2
        val encoded = AtomicFile(file).openRead().use { stream ->
            val output = java.io.ByteArrayOutputStream()
            val chunk = ByteArray(8192)
            var total = 0
            while (true) {
                val read = stream.read(chunk)
                if (read < 0) break
                total += read
                if (total > maximumCiphertextBytes) throw IllegalStateException("secure value is oversized")
                output.write(chunk, 0, read)
            }
            output.toByteArray()
        }
        val payload = Base64.decode(encoded, Base64.NO_WRAP)
        val buffer = ByteBuffer.wrap(payload)
        if (buffer.remaining() < 2 || buffer.get().toInt() != 1) throw IllegalStateException("bad secure value format")
        val ivLength = buffer.get().toInt() and 0xff
        if (ivLength != 12 || buffer.remaining() <= ivLength) throw IllegalStateException("bad secure value nonce")
        val iv = ByteArray(ivLength).also(buffer::get)
        val ciphertext = ByteArray(buffer.remaining()).also(buffer::get)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(128, iv))
        cipher.updateAAD(key.toByteArray(Charsets.UTF_8))
        return cipher.doFinal(ciphertext).toString(Charsets.UTF_8)
    }

    private fun legacyBackup(file: File): File = File(file.path + ".bak")

    private fun valueArtifacts(file: File): List<File> = listOf(file, legacyBackup(file), File(file.path + ".new"))

    private fun valueFile(key: String): File {
        val directory = File(context.noBackupFilesDir, "eliza-secure-store")
        if (!directory.exists() && !directory.mkdirs() && !directory.isDirectory) {
            throw IllegalStateException("secure store directory unavailable")
        }
        return File(directory, key.replace('.', '_') + ".enc")
    }

    private fun errorResult(code: String, message: String): JSObject = JSObject().apply {
        put("ok", false)
        put("error", code)
        put("message", message)
    }
}
