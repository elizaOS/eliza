package ai.eliza.plugins.camera

import android.content.ContentResolver
import android.content.ContentValues
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File
import java.io.IOException
import java.util.UUID

internal class GalleryImageWriteException(
    message: String,
    cause: Exception? = null,
    val uri: Uri? = null,
    val cleanupFailed: Boolean = false
) : IOException(message, cause)

/**
 * MediaStore columns that place one new item in the public DCIM/Camera album.
 * Android 10+ uses RELATIVE_PATH; older releases need an explicit public file
 * path, so every caller still receives a content:// MediaStore URI.
 */
@Suppress("DEPRECATION")
internal fun galleryMediaValues(displayName: String, mimeType: String, pending: Boolean): ContentValues {
    val values = ContentValues()
    values.put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
    values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, "DCIM/Camera")
        if (pending) values.put(MediaStore.MediaColumns.IS_PENDING, 1)
    } else {
        val album = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DCIM), "Camera")
        if (!album.isDirectory && !album.mkdirs()) throw IOException("Cannot create the DCIM/Camera directory")
        val dot = displayName.lastIndexOf('.')
        val stem = if (dot > 0) displayName.substring(0, dot) else displayName
        val extension = if (dot > 0) displayName.substring(dot) else ""
        var file = File(album, displayName)
        var suffix = 1
        while (file.exists()) file = File(album, "${stem}_${suffix++}$extension")
        values.put(MediaStore.MediaColumns.DATA, file.absolutePath)
    }
    return values
}

/** Owns one MediaStore insertion until it is published or removed. */
internal class GalleryImageWriter(
    private val resolver: ContentResolver,
    private val collection: Uri = MediaStore.Images.Media.EXTERNAL_CONTENT_URI
) {
    fun save(bytes: ByteArray, format: String): Uri {
        var uri: Uri? = null
        try {
            val values = galleryMediaValues("IMG_${UUID.randomUUID()}.$format", "image/$format", pending = true)
            val created = resolver.insert(collection, values)
                ?: throw IOException("Gallery provider did not create an image entry")
            uri = created
            val output = resolver.openOutputStream(created)
                ?: throw IOException("Gallery provider did not open an image stream")
            output.use { it.write(bytes) }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val published = resolver.update(created, ContentValues().apply {
                    put(MediaStore.MediaColumns.IS_PENDING, 0)
                }, null, null)
                if (published != 1) throw IOException("Gallery provider did not publish the image entry")
            }
            return created
        } catch (error: Exception) {
            var cleanupError: Exception? = null
            uri?.let { created ->
                try {
                    if (resolver.delete(created, null, null) != 1) throw IOException("Gallery provider did not remove the incomplete image")
                } catch (failure: Exception) { cleanupError = failure }
            }
            throw GalleryImageWriteException("Gallery image save failed: ${error.message}", error, uri, cleanupError != null).also {
                cleanupError?.let(it::addSuppressed)
            }
        }
    }
}
