package ai.eliza.plugins.camera

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.io.FileNotFoundException
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Fault provider is private to the acceptance APK; it never replaces MediaStore. */
class GalleryFailureProvider : ContentProvider() {
    companion object {
        const val AUTHORITY = "ai.eliza.plugins.camera.galleryfixture"
        var mode = "success"
        val events = mutableListOf<String>()
        var initialPending: Int? = null
        var finalPending: Int? = null
        var deleted = 0
    }
    private fun file() = File(requireNotNull(context).cacheDir, "gallery-provider-fixture.bin")
    override fun onCreate() = true
    override fun getType(uri: Uri) = "image/jpeg"
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, order: String?): Cursor? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? {
        events.add("insert")
        initialPending = values?.getAsInteger(MediaStore.Images.Media.IS_PENDING)
        return if (mode == "null-insert") null else Uri.withAppendedPath(uri, "1")
    }
    override fun openFile(uri: Uri, access: String): ParcelFileDescriptor? {
        events.add("open:$access")
        if (access == "r") return ParcelFileDescriptor.open(file(), ParcelFileDescriptor.MODE_READ_ONLY)
        if (mode == "null-stream") return null
        if (mode == "open-error") throw FileNotFoundException("Intentional fixture open failure")
        file().writeBytes(byteArrayOf())
        val flags = if (mode in setOf("write-error", "cleanup-error")) ParcelFileDescriptor.MODE_READ_ONLY else ParcelFileDescriptor.MODE_READ_WRITE
        return ParcelFileDescriptor.open(file(), flags)
    }
    override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?): Int {
        events.add("publish")
        finalPending = values?.getAsInteger(MediaStore.Images.Media.IS_PENDING)
        return if (mode == "publish-error") 0 else 1
    }
    override fun delete(uri: Uri, selection: String?, args: Array<out String>?): Int {
        events.add("delete")
        deleted++
        if (mode == "cleanup-error") throw IllegalStateException("Intentional fixture cleanup failure")
        file().delete()
        return 1
    }
}

@RunWith(AndroidJUnit4::class)
class GalleryImageWriterInstrumentedTest {
    @Test fun scopedWriterPublishesOnlyAfterWritingAndRetainsFailureDiagnostics() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val collection = Uri.parse("content://${GalleryFailureProvider.AUTHORITY}/images")
        val receipts = JSONArray()
        val bytes = byteArrayOf(1, 4, 9, 16)
        try {
            for (mode in listOf("success", "null-insert", "null-stream", "open-error", "write-error", "publish-error", "cleanup-error")) {
                GalleryFailureProvider.mode = mode
                GalleryFailureProvider.events.clear()
                GalleryFailureProvider.deleted = 0
                GalleryFailureProvider.initialPending = null
                GalleryFailureProvider.finalPending = null
                val receipt = JSONObject().put("fixtureMode", mode).put("scope", "Injected provider failures through the production writer; not a real MediaStore outage")
                receipts.put(receipt)
                try {
                    val uri = GalleryImageWriter(context.contentResolver, collection).save(bytes, "jpeg")
                    receipt.put("success", true).put("uri", uri.toString())
                    assertEquals("Only the successful fixture may publish", "success", mode)
                    assertArrayEquals(bytes, requireNotNull(context.contentResolver.openInputStream(uri)).use { it.readBytes() })
                    assertEquals(0, GalleryFailureProvider.finalPending)
                    assertEquals(0, GalleryFailureProvider.deleted)
                } catch (error: GalleryImageWriteException) {
                    receipt.put("success", false).put("message", error.message).put("cleanupFailed", error.cleanupFailed)
                        .put("uri", error.uri?.toString()).put("suppressed", error.suppressed.size)
                    assertNotEquals("success", mode)
                    assertNotNull(error.cause)
                    assertEquals(if (mode == "null-insert") 0 else 1, GalleryFailureProvider.deleted)
                    assertEquals(mode == "cleanup-error", error.cleanupFailed)
                    assertEquals(if (mode == "cleanup-error") 1 else 0, error.suppressed.size)
                    if (mode != "publish-error") assertNull(GalleryFailureProvider.finalPending)
                } finally {
                    receipt.put("events", JSONArray(GalleryFailureProvider.events)).put("initialPending", GalleryFailureProvider.initialPending)
                        .put("finalPending", GalleryFailureProvider.finalPending).put("deleteCalls", GalleryFailureProvider.deleted)
                    assertEquals(1, GalleryFailureProvider.initialPending)
                    File(context.cacheDir, "gallery-provider-fixture.bin").delete()
                }
            }
        } finally {
            GalleryFailureProvider.mode = "success"
            InstrumentationRegistry.getInstrumentation().sendStatus(2, Bundle().apply {
                putString("nativeArtifactName", "camera-gallery-provider-failures.json")
                putString("nativeArtifactBase64", Base64.encodeToString(receipts.toString().toByteArray(), Base64.NO_WRAP))
            })
        }
    }
}
