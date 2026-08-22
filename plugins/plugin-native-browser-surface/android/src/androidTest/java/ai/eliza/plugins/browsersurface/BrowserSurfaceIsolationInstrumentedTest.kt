/**
 * Proves on a real device or emulator that native Browser surfaces keep storage
 * isolated and yield rounded paint/input regions to host-rendered chrome.
 */
package ai.eliza.plugins.browsersurface

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.view.MotionEvent
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.Profile
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

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
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val store = ProfileStore.getInstance()
            val suffix = System.nanoTime()
            val profileA = store.getOrCreateProfile("eliza-surface-test-a-$suffix")
            val profileB = store.getOrCreateProfile("eliza-surface-test-b-$suffix")

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
    }

    @Test
    fun distinctIsolatedProfilesAreDistinctInstances() {
        assumeTrue(
            "multi-profile unsupported on this system WebView",
            WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE),
        )
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val store = ProfileStore.getInstance()
            val suffix = System.nanoTime()
            val a = store.getOrCreateProfile("eliza-surface-test-a-$suffix")
            val b = store.getOrCreateProfile("eliza-surface-test-b-$suffix")
            assertNotEquals(a.name, b.name)
        }
    }

    @Test
    fun sharedStorageUsesTheDefaultProfile() {
        assumeTrue(
            "multi-profile unsupported on this system WebView",
            WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE),
        )
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val store = ProfileStore.getInstance()
            val cmDefault = store.getOrCreateProfile(Profile.DEFAULT_PROFILE_NAME).cookieManager
            cmDefault.setCookie(urlShared, "shared=value")
            cmDefault.flush()
            // A second read of the default profile sees the shared write.
            val again = store.getOrCreateProfile(Profile.DEFAULT_PROFILE_NAME).cookieManager
            assertEquals(true, again.getCookie(urlShared)?.contains("shared=value"))
        }
    }

    @Test
    fun destroyedSurfaceProfileIsRetiredInsteadOfReusedInProcess() {
        assumeTrue(
            "multi-profile unsupported on this system WebView",
            WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE),
        )
        assumeTrue(
            "renderer introspection unsupported on this system WebView",
            WebViewFeature.isFeatureSupported(WebViewFeature.GET_WEB_VIEW_RENDERER),
        )
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val profileName = "eliza-surface-release-${System.nanoTime()}"
        lateinit var webView: WebView
        instrumentation.runOnMainSync {
            val store = ProfileStore.getInstance()
            val profile = store.getOrCreateProfile(profileName)
            profile.cookieManager.setCookie(urlA, "session=retired-secret")
            profile.cookieManager.flush()
            webView = WebView(context)
            WebViewCompat.setProfile(webView, profile.name)
            webView.loadUrl("about:blank")
            assertTrue(WebViewCompat.getWebViewRenderProcess(webView) != null)
            assertThrows(IllegalStateException::class.java) {
                store.deleteProfile(profileName)
            }
        }
        instrumentation.runOnMainSync {
            webView.stopLoading()
            webView.destroy()
        }
        instrumentation.waitForIdleSync()
        instrumentation.runOnMainSync {
            val store = ProfileStore.getInstance()
            assertThrows(IllegalStateException::class.java) {
                store.deleteProfile(profileName)
            }
            val replacementName = "$profileName-replacement"
            val replacement = store.getOrCreateProfile(replacementName)
            assertEquals(replacementName, replacement.name)
            assertNull(replacement.cookieManager.getCookie(urlA))
        }
    }

    @Test
    fun attachmentHostResolvesNearestFrameLayoutAncestorThroughNestedParents() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = FrameLayout(context)
        val intermediate = LinearLayout(context)
        val hostWebView = View(context)

        root.addView(intermediate)
        intermediate.addView(hostWebView)

        assertEquals(root, findNearestFrameLayoutAncestor(hostWebView))
    }

    @Test
    fun occlusionLayoutPunchesRoundedHostChromeOutOfNativePagePaint() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val surface = OccludingSurfaceLayout(context)
        val page = View(context).apply { setBackgroundColor(Color.RED) }
        surface.addView(page, FrameLayout.LayoutParams(100, 100))
        surface.setOuterClip(
            RoundedOuterClip(0f, 0f, 100f, 100f, 20f, 20f, 20f, 20f),
        )
        surface.setOcclusions(
            listOf(
                RoundedOcclusionRect(
                    left = 20f,
                    top = 20f,
                    right = 80f,
                    bottom = 80f,
                    cornerRadius = 20f,
                ),
            ),
        )
        val exact = View.MeasureSpec.makeMeasureSpec(100, View.MeasureSpec.EXACTLY)
        surface.measure(exact, exact)
        surface.layout(0, 0, 100, 100)
        val bitmap = Bitmap.createBitmap(100, 100, Bitmap.Config.ARGB_8888)
        surface.draw(Canvas(bitmap))

        assertEquals(Color.TRANSPARENT, bitmap.getPixel(0, 0))
        assertEquals(Color.RED, bitmap.getPixel(10, 20))
        assertEquals(Color.RED, bitmap.getPixel(21, 21))
        assertEquals(Color.TRANSPARENT, bitmap.getPixel(50, 50))
    }

    @Test
    fun outerClipStillRoundsThePageWithZeroOcclusionHoles() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val surface = OccludingSurfaceLayout(context)
        surface.addView(
            View(context).apply { setBackgroundColor(Color.RED) },
            FrameLayout.LayoutParams(100, 100),
        )
        surface.setOuterClip(
            RoundedOuterClip(0f, 0f, 100f, 100f, 20f, 20f, 20f, 20f),
        )
        surface.setOcclusions(emptyList())
        val exact = View.MeasureSpec.makeMeasureSpec(100, View.MeasureSpec.EXACTLY)
        surface.measure(exact, exact)
        surface.layout(0, 0, 100, 100)
        val bitmap = Bitmap.createBitmap(100, 100, Bitmap.Config.ARGB_8888)
        surface.draw(Canvas(bitmap))

        assertEquals(Color.TRANSPARENT, bitmap.getPixel(0, 0))
        assertEquals(Color.RED, bitmap.getPixel(50, 50))
    }

    @Test
    fun overlappingOcclusionHolesRemainAUnionInsideTheOuterClip() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val surface = OccludingSurfaceLayout(context)
        surface.addView(
            View(context).apply { setBackgroundColor(Color.RED) },
            FrameLayout.LayoutParams(100, 100),
        )
        surface.setOuterClip(
            RoundedOuterClip(0f, 0f, 100f, 100f, 16f, 16f, 16f, 16f),
        )
        surface.setOcclusions(
            listOf(
                RoundedOcclusionRect(20f, 20f, 60f, 70f, 0f),
                RoundedOcclusionRect(40f, 30f, 80f, 80f, 0f),
            ),
        )
        val exact = View.MeasureSpec.makeMeasureSpec(100, View.MeasureSpec.EXACTLY)
        surface.measure(exact, exact)
        surface.layout(0, 0, 100, 100)
        val bitmap = Bitmap.createBitmap(100, 100, Bitmap.Config.ARGB_8888)
        surface.draw(Canvas(bitmap))

        assertEquals(Color.TRANSPARENT, bitmap.getPixel(30, 40))
        assertEquals(Color.TRANSPARENT, bitmap.getPixel(50, 40))
        assertEquals(Color.TRANSPARENT, bitmap.getPixel(70, 40))
        assertEquals(Color.RED, bitmap.getPixel(90, 50))
    }

    @Test
    fun occlusionLayoutRelinquishesTouchesThatStartOnHostChrome() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val surface = OccludingSurfaceLayout(context)
        val page = View(context).apply {
            setOnTouchListener { _, _ -> true }
        }
        surface.addView(page, FrameLayout.LayoutParams(100, 100))
        surface.setOuterClip(
            RoundedOuterClip(0f, 0f, 100f, 100f, 20f, 20f, 20f, 20f),
        )
        surface.setOcclusions(
            listOf(RoundedOcclusionRect(20f, 20f, 80f, 80f, 0f)),
        )
        val exact = View.MeasureSpec.makeMeasureSpec(100, View.MeasureSpec.EXACTLY)
        surface.measure(exact, exact)
        surface.layout(0, 0, 100, 100)
        val inside = MotionEvent.obtain(0, 0, MotionEvent.ACTION_DOWN, 50f, 50f, 0)
        val pageTouch = MotionEvent.obtain(0, 0, MotionEvent.ACTION_DOWN, 10f, 50f, 0)
        val outside = MotionEvent.obtain(0, 0, MotionEvent.ACTION_DOWN, 0f, 0f, 0)

        assertFalse(surface.dispatchTouchEvent(inside))
        assertTrue(surface.dispatchTouchEvent(pageTouch))
        assertFalse(surface.dispatchTouchEvent(outside))
        inside.recycle()
        pageTouch.recycle()
        outside.recycle()
    }
}
