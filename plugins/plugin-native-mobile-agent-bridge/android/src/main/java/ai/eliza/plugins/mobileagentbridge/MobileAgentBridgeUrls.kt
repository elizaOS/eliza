package ai.eliza.plugins.mobileagentbridge

import android.net.Uri
import java.util.Locale

/**
 * Pure, Bridge-free URL construction + validation for the mobile-agent bridge (#9967).
 *
 * Extracted out of [MobileAgentBridgePlugin] so the two security/correctness-
 * sensitive transforms — upgrading a relay URL to a WebSocket scheme + injecting
 * the device identity, and the loopback-only allowlist for the local agent API
 * base — can be exercised by an on-device instrumented test. They are pure
 * (`Uri` in, `String?` out), so no Capacitor bridge is involved; the plugin
 * delegates here, behavior unchanged.
 */
object MobileAgentBridgeUrls {
    /**
     * Upgrades an http(s)/ws(s) relay URL to its WebSocket scheme, replaces the
     * device identity (`deviceId`) and any stale `token`, and re-appends the
     * caller's `token` when present. Unsupported schemes / unparseable input
     * yield `null` (the caller treats that as "no relay").
     */
    fun buildRelayUrl(raw: String, id: String, token: String?): String? {
        return try {
            val uri = Uri.parse(raw)
            val scheme = when (uri.scheme) {
                "https" -> "wss"
                "http" -> "ws"
                "wss", "ws" -> uri.scheme
                else -> return null
            }
            val builder = uri.buildUpon().scheme(scheme)
                .clearQuery()
                .appendQueryParameter("deviceId", id)
            for (name in uri.queryParameterNames) {
                if (name != "deviceId" && name != "token") {
                    for (value in uri.getQueryParameters(name)) {
                        builder.appendQueryParameter(name, value)
                    }
                }
            }
            if (token != null) builder.appendQueryParameter("token", token)
            builder.build().toString()
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Allowlist for the local agent API base: only the IPC sentinel itself, or
     * an `http` URL whose host is loopback / the Android-emulator host. Anything
     * else (remote host, https, garbage) collapses to `null` so the bridge never
     * talks to a non-local address. Returns [defaultBase] on success.
     */
    fun normalizeLocalAgentApiBase(raw: String, defaultBase: String): String? {
        return try {
            if (raw == defaultBase) return defaultBase
            val uri = Uri.parse(raw)
            val scheme = uri.scheme?.lowercase(Locale.US)
            val host = uri.host?.lowercase(Locale.US)
            if (scheme != "http") return null
            if (host !in setOf("127.0.0.1", "localhost", "10.0.2.2")) return null
            defaultBase
        } catch (_: Exception) {
            null
        }
    }
}
