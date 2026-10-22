/**
 * Which main-frame navigations an intercepting surface lets the page make by itself.
 *
 * A host that checks every address before it is shown (a blacklist, a look-alike check)
 * opts a surface into interception. The page may then move within its own origin; a
 * navigation to another origin, a cross-origin redirect included, is cancelled before any
 * request and handed to the host, which loads it with `navigate()` once its check allows it.
 * Non-web schemes and addresses carrying credentials never load. Pure JVM; no Android types.
 */
package ai.eliza.plugins.browsersurface

import java.net.URI
import java.util.Locale

object BrowserNavigationPolicy {
    enum class Decision {
        /** The page may load it: same origin as the page it leaves, or not a main-frame load. */
        ALLOW,

        /** Cancel it and ask the host, which navigates once its own check allows the address. */
        REQUEST,

        /** Cancel it: not an http(s) address, or one with embedded credentials. */
        BLOCK,
    }

    fun decide(current: String?, target: String, mainFrame: Boolean): Decision {
        if (!mainFrame) return Decision.ALLOW
        val next = web(target) ?: return Decision.BLOCK
        val from = current?.let(::web) ?: return Decision.REQUEST
        return if (origin(from) == origin(next)) Decision.ALLOW else Decision.REQUEST
    }

    private fun web(value: String): URI? {
        val uri = try {
            URI(value)
        } catch (error: java.net.URISyntaxException) {
            // error-policy:J3 A malformed address is refused, never guessed at.
            return null
        }
        val scheme = uri.scheme?.lowercase(Locale.ROOT)
        if ((scheme != "https" && scheme != "http") || uri.host.isNullOrBlank() || uri.rawUserInfo != null) return null
        return uri
    }

    private fun origin(uri: URI): Triple<String, String, Int> {
        val scheme = uri.scheme.lowercase(Locale.ROOT)
        val port = if (uri.port != -1) uri.port else if (scheme == "https") 443 else 80
        return Triple(scheme, uri.host.lowercase(Locale.ROOT).trimEnd('.'), port)
    }
}
