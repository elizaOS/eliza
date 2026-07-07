package ai.eliza.plugins.browsersurface

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.webkit.Profile
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewFeature
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Proves — on a real device/emulator — the storage-partitioning primitive the
 * plugin's `isolated` policy relies on: a cookie written into one androidx.webkit
 * [Profile] is invisible to a sibling profile and to the default (host) profile.
 * This is the cross-surface leak the isolation epic (#13452/#15245) closes,
 * exercised against the actual system WebView multi-profile store rather than a
 * mock. Gated by the MULTI_PROFILE feature (older system WebViews skip); on those
 * devices the plugin fails `createSurface` fast rather than degrading silently.
 */
@RunWith(AndroidJUnit4::class)
class BrowserSurfaceIsolationInstrumentedTest {
    private val urlA = "https://eliza-surface-a.example/"
    private val urlShared = "https://eliza-surface-shared.example/"

    @Test
    fun cookiesWrittenInAnIsolatedProfileAreInvisibleToSiblingsAndTheDefault() {
        assumeTrue(
            "multi-profile unsupported on this system WebView",
            WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE),
        )
        val store = ProfileStore.getInstance()
        val profileA = store.getOrCreateProfile("eliza-surface-test-a")
        val profileB = store.getOrCreateProfile("eliza-surface-test-b")

        val cmA = profileA.cookieManager
        val cmB = profileB.cookieManager
        val cmDefault = store.getOrCreateProfile(Profile.DEFAULT_PROFILE_NAME).cookieManager

        cmA.setCookie(urlA, "session=secret-A")
        cmA.flush()

        // Profile A sees its own cookie…
        assertTrue(cmA.getCookie(urlA)?.contains("secret-A") == true)
        // …but a sibling profile and the default profile do NOT.
        assertNull(cmB.getCookie(urlA))
        assertNull(cmDefault.getCookie(urlA))
    }

    @Test
    fun distinctIsolatedProfilesAreDistinctInstances() {
        assumeTrue(
            "multi-profile unsupported on this system WebView",
            WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE),
        )
        val store = ProfileStore.getInstance()
        val a = store.getOrCreateProfile("eliza-surface-test-a")
        val b = store.getOrCreateProfile("eliza-surface-test-b")
        assertNotEquals(a.name, b.name)
    }

    @Test
    fun sharedStorageUsesTheDefaultProfile() {
        assumeTrue(
            "multi-profile unsupported on this system WebView",
            WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE),
        )
        val store = ProfileStore.getInstance()
        val cmDefault = store.getOrCreateProfile(Profile.DEFAULT_PROFILE_NAME).cookieManager
        cmDefault.setCookie(urlShared, "shared=value")
        cmDefault.flush()
        // A second read of the default profile sees the shared write.
        val again = store.getOrCreateProfile(Profile.DEFAULT_PROFILE_NAME).cookieManager
        assertEquals(true, again.getCookie(urlShared)?.contains("shared=value"))
    }
}
