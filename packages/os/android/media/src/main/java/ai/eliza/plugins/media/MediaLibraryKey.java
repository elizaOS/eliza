package ai.eliza.plugins.media;

/**
 * Volume-qualified identity of one permitted library row: {@code m:<volume>:<i|v>:<id>}. A
 * MediaStore row number alone is not a device-wide identity, and the aggregate {@code external} or
 * {@code internal} volumes are refused so one key always names one typed, volume-specific row.
 * Pure Java so hosts and JVM tests can validate it without the Android framework.
 */
public final class MediaLibraryKey {
  public final String volume;
  public final long id;
  public final boolean video;
  public MediaLibraryKey(String volume, long id, boolean video) {
    if (volume == null || !volume.matches("[a-zA-Z0-9_-]{1,80}") || volume.equals("external")
        || volume.equals("internal") || id <= 0)
      throw new IllegalArgumentException("Invalid media identity");
    this.volume = volume;
    this.id = id;
    this.video = video;
  }
  public static MediaLibraryKey parse(String value) {
    if (value == null || value.length() > 128)
      throw new IllegalArgumentException("Invalid media identity");
    String[] parts = value.split(":", -1);
    if (parts.length != 4 || !parts[0].equals("m") || !parts[2].matches("[iv]")
        || !parts[3].matches("[1-9][0-9]*"))
      throw new IllegalArgumentException("Invalid media identity");
    return new MediaLibraryKey(parts[1], Long.parseLong(parts[3]), parts[2].equals("v"));
  }
  @Override
  public String toString() {
    return "m:" + volume + ":" + (video ? "v" : "i") + ":" + id;
  }
}
