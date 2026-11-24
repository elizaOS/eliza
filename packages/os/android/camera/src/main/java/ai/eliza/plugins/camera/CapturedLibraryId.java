package ai.eliza.plugins.camera;

// spec/os/android/camera.md, "The optional library id of a saved photo names the provider's own row"
final class CapturedLibraryId {
  private CapturedLibraryId() {}

  static String image(String volume, long id) {
    if (volume == null || !volume.matches("[a-zA-Z0-9_-]{1,80}") || volume.equals("external")
        || volume.equals("internal") || id <= 0)
      return null;
    return "m:" + volume + ":i:" + id;
  }
}
