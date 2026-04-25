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
    fun `isBlockedHostname honors allowlist precedence for X API hosts`() {
        val policy = SavedWebsiteBlock(
            requestedWebsites = listOf("x.com"),
            blockedWebsites = listOf(
                "x.com",
                "www.x.com",
                "mobile.x.com",
                "twitter.com",
                "www.twitter.com",
                "mobile.twitter.com",
                "t.co",
                "abs.twimg.com",
                "pbs.twimg.com",
                "video.twimg.com",
                "ton.twimg.com",
                "platform.twitter.com",
                "tweetdeck.twitter.com",
            ),
            allowedWebsites = listOf("api.x.com", "api.twitter.com"),
            matchMode = "exact",
            endsAtEpochMs = null,
        )

        assertTrue(WebsiteBlockerStateStore.isBlockedHostname(policy, "x.com"))
        assertTrue(
            WebsiteBlockerStateStore.isBlockedHostname(
                policy,
                "twitter.com",
            ),
        )
        assertFalse(
            WebsiteBlockerStateStore.isBlockedHostname(
                policy,
                "api.x.com",
            ),
        )
        assertFalse(
            WebsiteBlockerStateStore.isBlockedHostname(
                policy,
                "api.twitter.com",
            ),
        )
        assertFalse(
            WebsiteBlockerStateStore.isBlockedHostname(
                policy,
                "nottwitter.com",
            ),
        )
    }

    @Test
    fun `isBlockedHostname keeps Google News scoped`() {
        val policy = SavedWebsiteBlock(
            requestedWebsites = listOf("news.google.com"),
            blockedWebsites = listOf("news.google.com"),
            allowedWebsites = listOf(
                "accounts.google.com",
                "oauth2.googleapis.com",
                "openidconnect.googleapis.com",
                "www.googleapis.com",
            ),
            matchMode = "exact",
            endsAtEpochMs = null,
        )

        assertTrue(
            WebsiteBlockerStateStore.isBlockedHostname(
                policy,
                "news.google.com",
            ),
        )
        assertFalse(
            WebsiteBlockerStateStore.isBlockedHostname(
                policy,
                "accounts.google.com",
            ),
        )
        assertFalse(
            WebsiteBlockerStateStore.isBlockedHostname(
                policy,
                "oauth2.googleapis.com",
            ),
        )
        assertFalse(
            WebsiteBlockerStateStore.isBlockedHostname(
                policy,
                "openidconnect.googleapis.com",
            ),
        )
        assertFalse(
            WebsiteBlockerStateStore.isBlockedHostname(
                policy,
                "www.googleapis.com",
            ),
        )
    }
}
