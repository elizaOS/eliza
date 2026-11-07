package example.ownedmedia;

import ai.eliza.plugins.media.PermittedPhotosPlugin;
import ai.eliza.plugins.media.PhotoLibraryAccess;
import android.Manifest;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

/**
 * A host registration of the read-only Photos bridge for a host that only shows still photos: it
 * declares only the images alias and answers no media names.
 */
@CapacitorPlugin(
    name = "HostPhotoViewer",
    permissions = {@Permission(alias = "libraryImages", strings = {Manifest.permission.READ_MEDIA_IMAGES})})
public final class HostPhotoViewerPlugin extends PermittedPhotosPlugin {
  @Override
  protected PhotoLibraryAccess.Profile libraryProfile() {
    return PhotoLibraryAccess.Profile.IMAGES;
  }
}
