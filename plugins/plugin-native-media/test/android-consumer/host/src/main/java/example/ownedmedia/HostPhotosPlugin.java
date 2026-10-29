package example.ownedmedia;

import ai.eliza.plugins.media.OwnedMediaConfig;
import ai.eliza.plugins.media.PhotosPlugin;
import android.Manifest;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

/** A host registration of the shared Photos bridge: its plugin name and installed media names. */
@CapacitorPlugin(
    name = "HostPhotos",
    permissions = {
      @Permission(alias = "libraryLegacy", strings = {Manifest.permission.READ_EXTERNAL_STORAGE}),
      @Permission(alias = "libraryImages", strings = {Manifest.permission.READ_MEDIA_IMAGES}),
      @Permission(alias = "libraryVideos", strings = {Manifest.permission.READ_MEDIA_VIDEO}),
      @Permission(alias = "librarySelected", strings = {Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED})
    })
public final class HostPhotosPlugin extends PhotosPlugin {
  static final OwnedMediaConfig MEDIA =
      OwnedMediaConfig.builder("example")
          .edits("Pictures/Example/Edits/", "Example-edit-")
          .captures("Pictures/", "SCAN_")
          .videoEdits("Movies/Example/Edits/", "Example-video-edit-")
          .build();

  @Override
  protected OwnedMediaConfig mediaConfig() {
    return MEDIA;
  }

  @Override
  protected String playbackPath() {
    return "/_example_owned_video/";
  }
}
