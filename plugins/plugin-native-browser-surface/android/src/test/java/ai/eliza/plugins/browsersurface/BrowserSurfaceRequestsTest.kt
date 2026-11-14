/** Verifies what a surface reports and delivers for file inputs, site permissions and zoom. */
package ai.eliza.plugins.browsersurface

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BrowserSurfaceRequestsTest {
    @Test
    fun acceptTypesKeepOnlyMimeTypes() {
        assertEquals(listOf("image/*", "application/pdf"),
            BrowserSurfaceRequests.acceptTypes(arrayOf(" Image/* ", ".pdf", "application/pdf", null, "", "image/*", "text/html;x")))
        assertEquals(emptyList<String>(), BrowserSurfaceRequests.acceptTypes(null))
    }

    @Test
    fun pickedFilesAreContentUrisWithinTheInputsLimit() {
        assertTrue(BrowserSurfaceRequests.pickedFiles(listOf("content"), multiple = false))
        assertTrue(BrowserSurfaceRequests.pickedFiles(List(BrowserSurfaceRequests.MAX_FILES) { "content" }, multiple = true))
        assertFalse(BrowserSurfaceRequests.pickedFiles(emptyList(), multiple = true))
        assertFalse(BrowserSurfaceRequests.pickedFiles(listOf("content", "content"), multiple = false))
        assertFalse(BrowserSurfaceRequests.pickedFiles(List(BrowserSurfaceRequests.MAX_FILES + 1) { "content" }, multiple = true))
        assertFalse(BrowserSurfaceRequests.pickedFiles(listOf("content", "file"), multiple = true))
        assertFalse(BrowserSurfaceRequests.pickedFiles(listOf(null), multiple = false))
    }

    @Test
    fun onlyCameraAndMicrophoneAreOffered() {
        val camera = BrowserSurfaceRequests.VIDEO_CAPTURE
        val microphone = BrowserSurfaceRequests.AUDIO_CAPTURE
        assertEquals(listOf("camera", "microphone"),
            BrowserSurfaceRequests.mediaKinds(arrayOf(camera, "android.webkit.resource.PROTECTED_MEDIA_ID", microphone, camera, null)))
        assertEquals(listOf(microphone), BrowserSurfaceRequests.mediaResources(setOf("microphone", "location")))
    }

    @Test
    fun aGrantNeedsTheHostAppsOwnAndroidPermission() {
        val fine = "android.permission.ACCESS_FINE_LOCATION"
        val coarse = "android.permission.ACCESS_COARSE_LOCATION"
        val camera = "android.permission.CAMERA"
        assertNull(BrowserSurfaceRequests.androidPermissionsToAsk("camera", { false }, { true }))
        assertEquals(listOf(camera), BrowserSurfaceRequests.androidPermissionsToAsk("camera", { true }, { false }))
        assertEquals(emptyList<String>(), BrowserSurfaceRequests.androidPermissionsToAsk("camera", { true }, { true }))
        assertEquals(listOf(fine, coarse), BrowserSurfaceRequests.androidPermissionsToAsk("location", { true }, { false }))
        assertEquals(emptyList<String>(), BrowserSurfaceRequests.androidPermissionsToAsk("location", { true }, { it == coarse }))
        assertEquals(listOf(coarse), BrowserSurfaceRequests.androidPermissionsToAsk("location", { it == coarse }, { false }))
        assertNull(BrowserSurfaceRequests.androidPermissionsToAsk("midi", { true }, { true }))
    }

    @Test
    fun pageScaleIsCssPixelsPerDensityIndependentPixel() {
        assertEquals(1.0, BrowserSurfaceRequests.pageScale(2.625f, 2.625f), 0.0)
        assertEquals(0.4, BrowserSurfaceRequests.pageScale(1.05f, 2.625f), 0.0)
        assertEquals(2.5, BrowserSurfaceRequests.pageScale(6.5625f, 2.625f), 0.0)
        assertEquals(1.0, BrowserSurfaceRequests.pageScale(0f, 2.625f), 0.0)
    }
}
