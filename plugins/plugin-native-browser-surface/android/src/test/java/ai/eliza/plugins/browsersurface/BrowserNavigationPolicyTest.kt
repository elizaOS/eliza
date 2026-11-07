/** Verifies which main-frame navigations an intercepting surface holds for the host. */
package ai.eliza.plugins.browsersurface

import ai.eliza.plugins.browsersurface.BrowserNavigationPolicy.Decision
import org.junit.Assert.assertEquals
import org.junit.Test

class BrowserNavigationPolicyTest {
    private fun decide(current: String?, target: String, mainFrame: Boolean = true) =
        BrowserNavigationPolicy.decide(current, target, mainFrame)

    @Test
    fun sameOriginNavigationsLoadByThemselves() {
        assertEquals(Decision.ALLOW, decide("https://en.wikipedia.org/wiki/Main_Page", "https://en.wikipedia.org/wiki/Paris"))
        assertEquals(Decision.ALLOW, decide("https://Example.com/a", "https://example.com/b?q=1#top"))
        assertEquals(Decision.ALLOW, decide("https://example.com/", "https://example.com:443/next"))
        assertEquals(Decision.ALLOW, decide("http://example.com/", "http://example.com:80/next"))
    }

    @Test
    fun anotherOriginWaitsForTheHost() {
        assertEquals(Decision.REQUEST, decide("https://wikipedia.org/", "https://www.wikipedia.org/"))
        assertEquals(Decision.REQUEST, decide("https://example.com/", "https://evil.example.net/"))
        assertEquals(Decision.REQUEST, decide("https://example.com/", "http://example.com/"))
        assertEquals(Decision.REQUEST, decide("https://example.com/", "https://example.com:8443/"))
        assertEquals(Decision.REQUEST, decide("https://example.com/", "https://example.com./next"))
        assertEquals(Decision.REQUEST, decide(null, "https://example.com/"))
        assertEquals(Decision.REQUEST, decide("about:blank", "https://example.com/"))
    }

    @Test
    fun nonWebAndCredentialAddressesNeverLoad() {
        for (target in listOf("javascript:alert(1)", "intent://scan/#Intent;end", "file:///data/data/app", "mailto:a@example.com",
                "tel:5550100", "data:text/html,hi", "https://user:secret@example.com/", "https:///missing-host", "not a url")) {
            assertEquals(target, Decision.BLOCK, decide("https://example.com/", target))
        }
    }

    @Test
    fun hostExtendedTaskOriginsReachEachOther() {
        val task = setOf("https://www.ssa.gov", "https://secure.login.gov")
        assertEquals(Decision.ALLOW, BrowserNavigationPolicy.decide("https://www.ssa.gov/", "https://secure.login.gov/sign-in", true, task))
        assertEquals(Decision.ALLOW, BrowserNavigationPolicy.decide("https://secure.login.gov/x", "https://www.ssa.gov/back", true, task))
        assertEquals(Decision.REQUEST, BrowserNavigationPolicy.decide("https://www.ssa.gov/", "https://evil.example.net/", true, task))
        assertEquals(Decision.REQUEST, BrowserNavigationPolicy.decide("https://evil.example.net/", "https://www.ssa.gov/", true, task))
        assertEquals(Decision.REQUEST, decide("https://www.ssa.gov/", "https://secure.login.gov/"))
        assertEquals(Decision.BLOCK, BrowserNavigationPolicy.decide("https://www.ssa.gov/", "javascript:alert(1)", true, task))
    }

    @Test
    fun subframesAreNotHeld() {
        assertEquals(Decision.ALLOW, decide("https://example.com/", "https://ads.example.net/frame", mainFrame = false))
    }
}
