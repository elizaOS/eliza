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
    fun aRefusedCertificateFailsThePageBeforeAnyOtherError() {
        val refused = BrowserSurfaceRequests.CERTIFICATE_REFUSED
        assertNull(BrowserSurfaceRequests.pageFailure(null, null))
        assertEquals(refused, BrowserSurfaceRequests.pageFailure(null, "https://a.test/"))
        assertEquals(refused, BrowserSurfaceRequests.pageFailure("net::ERR_FAILED", "https://a.test/"))
        assertEquals("net::ERR_FAILED", BrowserSurfaceRequests.pageFailure("net::ERR_FAILED", null))
    }

    @Test
    fun pageScaleIsDensityIndependentPixelsPerCssPixel() {
        assertEquals(1.0, BrowserSurfaceRequests.pageScale(2.625f, 2.625f), 0.0)
        assertEquals(0.4, BrowserSurfaceRequests.pageScale(1.05f, 2.625f), 0.0)
        assertEquals(2.5, BrowserSurfaceRequests.pageScale(6.5625f, 2.625f), 0.0)
        assertEquals(1.0, BrowserSurfaceRequests.pageScale(0f, 2.625f), 0.0)
    }

    @Test
    fun aSignInPageOpensInABrowserOtherThanThisApp() {
        val own = "technology.graceful.grace"
        assertEquals("com.android.chrome",
            BrowserSurfaceRequests.identityBrowser(own, "com.android.chrome", listOf(own, "org.mozilla.firefox", "com.android.chrome")))
        // This app as the default, or the system resolver, falls back to another browser.
        assertEquals("org.mozilla.firefox", BrowserSurfaceRequests.identityBrowser(own, own, listOf(own, "org.mozilla.firefox")))
        assertEquals("org.mozilla.firefox", BrowserSurfaceRequests.identityBrowser(own, "android", listOf("org.mozilla.firefox")))
        assertNull(BrowserSurfaceRequests.identityBrowser(own, own, listOf(own)))
        assertNull(BrowserSurfaceRequests.identityBrowser(own, null, emptyList()))
    }

    private class Permission(val source: Any)

    @Test
    fun aWithdrawnPermissionLeavesUnansweredAndFreesItsPlace() {
        val holds = SurfaceHolds<String, Permission, String>()
        val camera = Any()
        val cameraId = holds.permissions.open(Permission(camera))
        val locationId = holds.permissions.open(Permission("location"))
        assertEquals(listOf(cameraId), holds.permissions.withdraw { it.source === camera }.keys.toList())
        assertEquals(1, holds.permissions.size())
        // The host's late answer to the withdrawn request finds nothing.
        assertNull(holds.permissions.take(cameraId))
        assertEquals("location", holds.permissions.take(locationId)?.source)
        assertNull(holds.permissions.take(locationId))
    }

    @Test
    fun closingEndsEverythingAndStaleRequestIdsFindNothing() {
        val holds = SurfaceHolds<String, Permission, String>()
        val (firstFile, none) = holds.holdFile("first input")
        assertNull(none)
        val (fileId, replaced) = holds.holdFile("second input")
        assertEquals("first input", replaced)
        assertNull(holds.file(firstFile))
        assertEquals("second input", holds.file(fileId))
        val permissionId = holds.permissions.open(Permission("camera"))
        val oldDownload = holds.holdDownload("old file")
        val downloadId = holds.holdDownload("report.pdf")
        assertNull(holds.takeDownload(oldDownload))

        val closed = holds.close()
        assertEquals("second input", closed.file)
        assertEquals(listOf(permissionId), closed.permissions.keys.toList())
        assertNull(holds.file(fileId))
        assertNull(holds.takeFile(fileId))
        assertNull(holds.permissions.get(permissionId))
        assertNull(holds.takeDownload(downloadId))
        val again = holds.close()
        assertNull(again.file)
        assertTrue(again.permissions.isEmpty())
    }

    @Test
    fun aSitePermissionAnswerSaysWhy() {
        fun outcome(held: Boolean = true, grant: Boolean = true, samePage: Boolean = true, missing: Boolean = false, androidAnswered: Boolean = false) =
            BrowserSurfaceRequests.sitePermissionOutcome(held, grant, samePage, missing, androidAnswered)
        assertEquals("granted", outcome())
        assertEquals("granted", outcome(androidAnswered = true))
        assertEquals("denied", outcome(grant = false, missing = true))
        assertEquals("ended", outcome(held = false, grant = false))
        assertEquals("ended", outcome(samePage = false))
        assertEquals("android-refused", outcome(missing = true, androidAnswered = true))
        // Android returned no answer (another request was showing) or no dialog could open.
        assertEquals("ended", outcome(missing = true))
        assertTrue(BrowserSurfaceRequests.capturesMedia(listOf("location", "microphone")))
        assertFalse(BrowserSurfaceRequests.capturesMedia(listOf("location")))
    }

    @Test
    fun aHeldDialogRefusesHistoryNavigationBeforeDispatch() {
        // A frozen page could take the traversal only after its dialog is answered, unawaited.
        assertEquals("DIALOG_OPEN", BrowserSurfaceRequests.historyRefusal(dialogHeld = true, current = true))
        assertEquals("DIALOG_OPEN", BrowserSurfaceRequests.historyRefusal(dialogHeld = true, current = false))
        assertEquals("STALE_REF", BrowserSurfaceRequests.historyRefusal(dialogHeld = false, current = false))
        assertNull(BrowserSurfaceRequests.historyRefusal(dialogHeld = false, current = true))
    }

    @Test
    fun anAnswerTakesItsRequestOnce() {
        val holds = SurfaceHolds<String, Permission, String>()
        val (fileId, _) = holds.holdFile("input")
        assertNull(holds.takeFile("someone-else"))
        assertEquals("input", holds.takeFile(fileId))
        assertNull(holds.takeFile(fileId))
        val downloadId = holds.holdDownload("report.pdf")
        assertNull(holds.takeDownload(null))
        assertEquals("report.pdf", holds.takeDownload(downloadId))
        assertNull(holds.takeDownload(downloadId))
    }
}
