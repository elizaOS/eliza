package example.ownedmedia;

import ai.eliza.plugins.media.DeviceLibraryPlugin;
import android.Manifest;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

/** A host registration of the shared agent album facade over {@link HostPhotosPlugin}. */
@CapacitorPlugin(
    name = "HostDeviceLibrary",
    permissions = {
      @Permission(alias = "libraryLegacy", strings = {Manifest.permission.READ_EXTERNAL_STORAGE}),
      @Permission(alias = "libraryImages", strings = {Manifest.permission.READ_MEDIA_IMAGES}),
      @Permission(alias = "libraryVideos", strings = {Manifest.permission.READ_MEDIA_VIDEO}),
      @Permission(alias = "librarySelected", strings = {Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED})
    })
public final class HostDeviceLibraryPlugin extends DeviceLibraryPlugin {
  @Override
  protected String photosPluginName() {
    return "HostPhotos";
  }
}
