/** Verifies the native full-browser boundary rejects non-web and credential-bearing URLs. */
package ai.eliza.plugins.browsersurface

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
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

    @Test
    fun trustRequiresAndroidPAPinnedDigestAndMatchingSigner() {
        val digest = "ab".repeat(32)
        var asked: Pair<String, ByteArray>? = null
        assertTrue(ChromiumBrowserLauncher.isTrusted(28, digest) { packageName, certificate ->
            asked = packageName to certificate
            true
        })
        assertEquals(ChromiumBrowserLauncher.PACKAGE_NAME, asked!!.first)
        assertEquals(32, asked!!.second.size)
        assertEquals(0xab.toByte(), asked!!.second[0])

        assertFalse(ChromiumBrowserLauncher.isTrusted(28, digest) { _, _ -> false })
        assertFalse(ChromiumBrowserLauncher.isTrusted(27, digest) { _, _ -> true })
        assertFalse(ChromiumBrowserLauncher.isTrusted(28, "") { _, _ -> true })
        assertFalse(ChromiumBrowserLauncher.isTrusted(28, "not-a-digest") { _, _ -> true })
    }
}
