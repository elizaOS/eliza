package ai.eliza.plugins.camera

import android.content.ContentResolver
import android.content.ContentValues
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import java.io.IOException
import java.util.UUID

internal class GalleryImageWriteException(
    message: String,
    cause: Exception? = null,
    val uri: Uri? = null,
    val cleanupFailed: Boolean = false
) : IOException(message, cause)

/** Owns one scoped MediaStore insertion until it is published or removed. */
internal class GalleryImageWriter(
    private val resolver: ContentResolver,
    private val collection: Uri = MediaStore.Images.Media.EXTERNAL_CONTENT_URI
) {
    fun save(bytes: ByteArray, format: String): Uri {
        var uri: Uri? = null
        try {
            val values = ContentValues().apply {
                put(MediaStore.Images.Media.DISPLAY_NAME, "IMG_${UUID.randomUUID()}.$format")
                put(MediaStore.Images.Media.MIME_TYPE, "image/$format")
                put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES)
                put(MediaStore.Images.Media.IS_PENDING, 1)
            }
            val created = resolver.insert(collection, values)
                ?: throw IOException("Gallery provider did not create an image entry")
            uri = created
            val output = resolver.openOutputStream(created)
                ?: throw IOException("Gallery provider did not open an image stream")
            output.use { it.write(bytes) }
            val published = resolver.update(created, ContentValues().apply {
                put(MediaStore.Images.Media.IS_PENDING, 0)
            }, null, null)
            if (published != 1) throw IOException("Gallery provider did not publish the image entry")
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
