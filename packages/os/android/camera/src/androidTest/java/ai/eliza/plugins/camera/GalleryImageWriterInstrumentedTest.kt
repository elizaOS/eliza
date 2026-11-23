package ai.eliza.plugins.camera

import android.content.ContentProvider
import android.content.ContentUris
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.provider.BaseColumns
import android.provider.MediaStore
import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.ByteArrayOutputStream
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
        var row: Array<Any?>? = null
    }
    private fun file() = File(requireNotNull(context).cacheDir, "gallery-provider-fixture.bin")
    override fun onCreate() = true
    override fun getType(uri: Uri) = "image/jpeg"
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, order: String?): Cursor? {
        if (mode == "query-error") throw IllegalStateException("Intentional fixture query failure")
        val values = row ?: return null
        return MatrixCursor(requireNotNull(projection)).apply {
            addRow(projection.map { if (it == MediaStore.MediaColumns.VOLUME_NAME) values[1] else values[0] })
        }
    }
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

    // spec/nativeCamera/index.md, "Story: Take a picture or record a clip through the current camera view"
    @Test fun savedPhotoLibraryIdNamesTheRowsOwnVolume() {
        org.junit.Assume.assumeTrue(android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q)
        val resolver = InstrumentationRegistry.getInstrumentation().targetContext.contentResolver
        val collection = Uri.parse("content://${GalleryFailureProvider.AUTHORITY}/images")
        GalleryFailureProvider.mode = "success"
        val bytes = byteArrayOf(1, 4, 9, 16)
        val saved = GalleryImageWriter(resolver, collection).save(bytes, "jpeg")
        try {
            GalleryFailureProvider.row = arrayOf(42L, "external_primary")
            assertEquals("m:external_primary:i:42", savedImageLibraryId(resolver, saved))
            GalleryFailureProvider.row = arrayOf(7L, "1a2b-3c4d")
            assertEquals("m:1a2b-3c4d:i:7", savedImageLibraryId(resolver, saved))
            GalleryFailureProvider.row = arrayOf(42L, "external")
            assertNull(savedImageLibraryId(resolver, saved))
            GalleryFailureProvider.row = arrayOf(42L, null)
            assertNull(savedImageLibraryId(resolver, saved))
            GalleryFailureProvider.row = null
            assertNull(savedImageLibraryId(resolver, saved))
            GalleryFailureProvider.mode = "query-error"
            GalleryFailureProvider.row = arrayOf(42L, "external_primary")
            assertNull(savedImageLibraryId(resolver, saved))
            assertArrayEquals(bytes, requireNotNull(resolver.openInputStream(saved)).use { it.readBytes() })
        } finally {
            GalleryFailureProvider.mode = "success"
            GalleryFailureProvider.row = null
            resolver.delete(saved, null, null)
        }

        val bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
        val jpeg = try {
            ByteArrayOutputStream().use { encoded ->
                assertTrue(bitmap.compress(Bitmap.CompressFormat.JPEG, 80, encoded))
                encoded.toByteArray()
            }
        } finally {
            bitmap.recycle()
        }
        val mediaStoreUri = GalleryImageWriter(resolver).save(jpeg, "jpeg")
        val receipt = try {
            val primaryVolume = MediaStore.VOLUME_EXTERNAL_PRIMARY
            val primaryRow = ContentUris.withAppendedId(MediaStore.Images.Media.getContentUri(primaryVolume), ContentUris.parseId(mediaStoreUri))
            val columns = arrayOf(BaseColumns._ID, MediaStore.MediaColumns.VOLUME_NAME, MediaStore.MediaColumns.IS_PENDING)
            val rowId = requireNotNull(resolver.query(primaryRow, columns, null, null, null)).use { row ->
                assertTrue(row.moveToFirst())
                assertEquals(primaryVolume, row.getString(1))
                assertEquals(0, row.getInt(2))
                row.getLong(0)
            }
            val libraryId = savedImageLibraryId(resolver, mediaStoreUri)
            assertEquals("m:$primaryVolume:i:$rowId", libraryId)
            val savedBytes = requireNotNull(resolver.openInputStream(primaryRow)).use { it.readBytes() }
            assertArrayEquals(jpeg, savedBytes)
            val decoded = requireNotNull(BitmapFactory.decodeByteArray(savedBytes, 0, savedBytes.size))
            try {
                assertEquals(2, decoded.width)
                assertEquals(2, decoded.height)
            } finally {
                decoded.recycle()
            }
            JSONObject().put("volume", primaryVolume).put("rowId", rowId).put("libraryId", libraryId).put("bytes", savedBytes.size)
        } finally {
            assertEquals(1, resolver.delete(mediaStoreUri, null, null))
        }
        InstrumentationRegistry.getInstrumentation().sendStatus(2, Bundle().apply {
            putString("nativeArtifactName", "camera-gallery-media-store-row.json")
            putString("nativeArtifactBase64", Base64.encodeToString(receipt.put("deleted", true).toString().toByteArray(), Base64.NO_WRAP))
        })
    }
}
