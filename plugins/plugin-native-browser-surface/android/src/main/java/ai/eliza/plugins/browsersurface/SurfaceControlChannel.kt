package ai.eliza.plugins.browsersurface

import android.net.Uri
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import org.json.JSONObject

/** Main-thread, main-frame commands. The website never receives the bridge object. */
internal class SurfaceControlChannel(private val webView: WebView, script: String) {
    private var documentId: String? = null
    private var documentOrigin: Uri? = null
    private var proxy: JavaScriptReplyProxy? = null
    private var snapshotId: String? = null
    private var sequence = 0L
    private data class Pending(
        val call: PluginCall,
        val documentId: String,
        val sequence: Long,
        val effect: Boolean,
        val observation: Boolean,
        val isCurrent: () -> Boolean,
        val timeout: Runnable,
    )
    private var pending: Pending? = null

    init {
        val world = WebViewCompat.getExecutionWorld(webView, "eliza-surface-control-v1")
        WebViewCompat.addWebMessageListener(
            webView, "elizaSurfaceControl", setOf("*"), world,
        ) { _, message, origin, mainFrame, reply ->
            if (!mainFrame || origin.scheme !in setOf("http", "https")) return@addWebMessageListener
            val data = try { JSONObject(message.data ?: return@addWebMessageListener) }
                catch (_: Exception) { return@addWebMessageListener }
            val incomingDocument = data.optString("documentId")
            if (incomingDocument.isBlank()) return@addWebMessageListener
            if (data.optBoolean("ready")) {
                if (documentId != incomingDocument) interrupt("The browser document changed")
                documentId = incomingDocument
                // Document-start messages can arrive before WebView.url is
                // updated. Retain the native-reported origin and validate it
                // against the loaded surface at dispatch and on every reply.
                documentOrigin = origin
                proxy = reply
                return@addWebMessageListener
            }
            if (!sameOrigin(origin, webView.url)) return@addWebMessageListener
            val request = pending ?: return@addWebMessageListener
            if (incomingDocument != request.documentId || data.optLong("sequence", -1) != request.sequence) {
                return@addWebMessageListener
            }
            pending = null
            webView.removeCallbacks(request.timeout)
            if (!request.isCurrent()) {
                request.call.reject("The page context changed; observe before continuing", outcomeCode(request.effect))
                return@addWebMessageListener
            }
            val result = data.optJSONObject("result")
            if (result == null) {
                request.call.reject("The page returned an invalid command result", outcomeCode(request.effect))
            } else {
                val error = result.optJSONObject("error")
                if (error != null) request.call.reject(error.optString("message"), error.optString("kind"))
                else {
                    if (request.observation) snapshotId = result.optString("snapshotId").takeIf { it.isNotBlank() }
                    request.call.resolve(JSObject().apply {
                        put("documentId", incomingDocument)
                        put("frameScope", "main")
                        put("result", result)
                    })
                }
            }
        }
        WebViewCompat.addJavaScriptOnEvent(
            webView, script, WebViewCompat.INJECTION_EVENT_DOCUMENT_START, setOf("*"), world,
        )
    }

    fun execute(call: PluginCall, command: JSONObject, expectedDocument: String?, isCurrent: () -> Boolean) {
        val action = command.optString("subaction")
        val input = action in setOf("click", "fill", "select", "scroll")
        val effect = input && command.opt("validateOnly") != true
        val observation = action == "snapshot"
        val guidance = command.optJSONObject("guidance")
        val referenced = input || (action == "guide" && guidance?.optString("kind") in setOf("show", "action-status"))
        val currentDocument = documentId
        val currentProxy = proxy
        if (currentDocument == null || currentProxy == null ||
            documentOrigin?.let { sameOrigin(it, webView.url) } != true || !isCurrent()) {
            call.reject("The isolated page control channel is not ready", "UNAVAILABLE")
            return
        }
        if (referenced && expectedDocument != currentDocument) {
            call.reject("Observe the current document before acting", "STALE_REF")
            return
        }
        if (pending != null) {
            call.reject("A page command is still awaiting its result", "BUSY")
            return
        }
        val expectedSnapshot = if (action == "guide") guidance?.optString("snapshotId") else command.optString("snapshotId")
        if (referenced && (snapshotId == null || expectedSnapshot != snapshotId)) {
            call.reject("Read a fresh snapshot before acting on this page", "STALE_REF")
            return
        }
        // Native invalidation covers visibility/lifecycle changes even if the
        // DOM and its isolated-world snapshot happen to remain unchanged.
        if (effect || observation) snapshotId = null
        sequence += 1
        val timeout = Runnable { interrupt("The page command timed out; observe before continuing") }
        pending = Pending(call, currentDocument, sequence, effect, observation, isCurrent, timeout)
        webView.postDelayed(timeout, 5000)
        try {
            currentProxy.postMessage(JSONObject().apply {
                put("documentId", currentDocument)
                put("sequence", sequence)
                put("command", command)
            }.toString())
        } catch (_: Exception) {
            interrupt("The page command connection failed; observe before continuing")
        }
    }

    fun interrupt(message: String, navigation: Boolean = false) {
        snapshotId = null
        val request = pending
        pending = null
        if (navigation) {
            documentId = null
            documentOrigin = null
            proxy = null
        }
        if (request != null) {
            webView.removeCallbacks(request.timeout)
            request.call.reject(message, outcomeCode(request.effect))
        }
    }

    companion object {
        fun supported(): Boolean = WebViewFeature.isFeatureSupported(WebViewFeature.JS_INJECTION_IN_FRAME_AND_WORLD)
        private fun outcomeCode(effect: Boolean) = if (effect) "UNCERTAIN_OUTCOME" else "STALE_REF"
        private fun sameOrigin(origin: Uri, address: String?): Boolean {
            val current = address?.let(Uri::parse) ?: return false
            fun port(uri: Uri) = if (uri.port != -1) uri.port else if (uri.scheme == "https") 443 else 80
            return origin.scheme in setOf("http", "https") && origin.scheme == current.scheme &&
                origin.host == current.host && port(origin) == port(current)
        }
    }
}
