/** Verifies the native full-browser boundary rejects non-web and credential-bearing URLs. */
package ai.eliza.plugins.browsersurface

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ChromiumBrowserLauncherTest {
    @Test
    fun preservesWebsitePathsQueriesAndFragments() {
        val url = "https://accounts.google.com/signin?continue=https%3A%2F%2Fwww.google.com#next"
        assertEquals(url, ChromiumBrowserLauncher.validatedUrl(url))
        assertEquals("http://localhost:8080/", ChromiumBrowserLauncher.validatedUrl("http://localhost:8080/"))
    }

    @Test
    fun rejectsUnsafeSchemesCredentialsAndMalformedAddresses() {
        for (url in listOf("javascript:alert(1)", "intent://scan/#Intent;end", "file:///data/data/app", "https:///missing-host", "https://user:secret@example.com/", "https://example.com:65536/", "https://example.com/\nheader", "")) {
            val failure = assertThrows(BrowserLaunchException::class.java) {
                ChromiumBrowserLauncher.validatedUrl(url)
            }
            assertEquals("INVALID_BROWSER_URL", failure.code)
        }
    }
}
