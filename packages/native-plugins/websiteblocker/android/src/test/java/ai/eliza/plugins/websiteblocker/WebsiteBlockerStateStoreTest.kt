package ai.eliza.plugins.websiteblocker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WebsiteBlockerStateStoreTest {
    @Test
    fun `normalizeHostname trims casing and trailing dots`() {
        assertEquals(
            "twitter.com",
            WebsiteBlockerStateStore.normalizeHostname("  TWITTER.COM.  "),
        )
    }

    @Test
    fun `normalizeHostname rejects invalid inputs`() {
        assertNull(WebsiteBlockerStateStore.normalizeHostname(""))
        assertNull(WebsiteBlockerStateStore.normalizeHostname("localhost"))
        assertNull(WebsiteBlockerStateStore.normalizeHostname("exa mple.com"))
        assertNull(WebsiteBlockerStateStore.normalizeHostname("https://x.com"))
    }

    @Test
    fun `isBlockedHostname matches exact domains and subdomains`() {
        val blocked = setOf("x.com", "twitter.com")

        assertTrue(WebsiteBlockerStateStore.isBlockedHostname(blocked, "x.com"))
        assertTrue(
            WebsiteBlockerStateStore.isBlockedHostname(
                blocked,
                "api.twitter.com",
            ),
        )
        assertFalse(
            WebsiteBlockerStateStore.isBlockedHostname(
                blocked,
                "nottwitter.com",
            ),
        )
        assertFalse(
            WebsiteBlockerStateStore.isBlockedHostname(
                blocked,
                "example.org",
            ),
        )
    }
}
