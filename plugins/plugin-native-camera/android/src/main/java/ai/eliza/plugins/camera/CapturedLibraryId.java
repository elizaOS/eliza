package ai.eliza.plugins.camera;

/**
 * The library id of a photo the camera saved: {@code m:<volume>:i:<id>}, the key format the media
 * plugin's {@code MediaLibraryKey} reads. A MediaStore row number names a row only within one
 * volume, so the key carries the row's own {@code VOLUME_NAME}; the aggregate {@code external} and
 * {@code internal} volumes name no single row and give no id. Pure Java so JVM tests can check it
 * without the Android framework.
 */
final class CapturedLibraryId {
  private CapturedLibraryId() {}

  /** The image key for one saved row, or null when the volume or row id cannot name it. */
  static String image(String volume, long id) {
    if (volume == null || !volume.matches("[a-zA-Z0-9_-]{1,80}") || volume.equals("external")
        || volume.equals("internal") || id <= 0)
      return null;
    return "m:" + volume + ":i:" + id;
  }
}
