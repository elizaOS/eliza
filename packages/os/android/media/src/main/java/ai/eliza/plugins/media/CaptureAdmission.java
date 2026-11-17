package ai.eliza.plugins.media;

/**
 * Admission for explicitly kept captures. A capture held in memory (for example a document
 * scan) reaches the host's Photos only through a deliberate keep, with exact JPEG bytes of a
 * bounded size. Pure Java so JVM tests cover it.
 */
public final class CaptureAdmission {
  public static final int MAX_BYTES = 16 * 1024 * 1024;

  /** Returns the decoded JPEG or throws with a user-presentable reason. */
  public static byte[] jpeg(String base64) {
    // Bound allocation before decoding renderer-supplied text, including MIME line wrapping.
    if (base64 != null && base64.length() > ((MAX_BYTES + 2) / 3) * 4 + 1024 * 1024)
      throw new IllegalArgumentException("Only a captured JPEG up to 16 MB can be kept.");
    byte[] bytes;
    try {
      bytes = java.util.Base64.getMimeDecoder().decode(base64 == null ? "" : base64);
    } catch (IllegalArgumentException invalid) {
      bytes = new byte[0];
    }
    if (bytes.length < 4 || bytes.length > MAX_BYTES || (bytes[0] & 255) != 0xFF
        || (bytes[1] & 255) != 0xD8)
      throw new IllegalArgumentException("Only a captured JPEG up to 16 MB can be kept.");
    return bytes;
  }
  private CaptureAdmission() {}
}
