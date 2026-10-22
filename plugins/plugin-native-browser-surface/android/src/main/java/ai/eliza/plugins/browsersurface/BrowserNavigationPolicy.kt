/**
 * Which main-frame navigations an intercepting surface lets the page make by itself.
 *
 * A host that checks every address before it is shown (a blacklist, a look-alike check)
 * opts a surface into interception. The page may then move within its own origin; a
 * navigation to another origin, a cross-origin redirect included, is cancelled before any
 * request and handed to the host, which loads it with `navigate()` once its check allows it.
 * Non-web schemes and addresses carrying credentials are refused in this callback.
 * POST submissions and subframes are outside this handoff. Pure JVM; no Android types.
 */
package ai.eliza.plugins.browsersurface

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
        val next = BrowserWebOrigin.of(target) ?: return Decision.BLOCK
        val from = BrowserWebOrigin.of(current) ?: return Decision.REQUEST
        return if (from == next) Decision.ALLOW else Decision.REQUEST
    }
}
