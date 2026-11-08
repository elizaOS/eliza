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
  /**
   * Revision prefix for a MediaStore version. The provider documents the version as opaque, and
   * some builds return {@code version:uuid}; the SHA-256 digest, base64url without padding (43
   * characters), keeps a revision one colon-free prefix followed by numbers on every build.
   */
  public static String revisionPrefix(String providerVersion) {
    try {
      return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(
          java.security.MessageDigest.getInstance("SHA-256").digest(
              providerVersion.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    } catch (java.security.NoSuchAlgorithmException missing) {
      throw new IllegalStateException(missing);
    }
  }
  @Override
  public String toString() {
    return "m:" + volume + ":" + (video ? "v" : "i") + ":" + id;
  }
}
