package ai.eliza.plugins.browsersurface;

/**
 * Size and quality of a masked page screenshot ({@code captureSurface}).
 *
 * <p>A vision fallback needs a readable page, not a pixel copy: about 1024 px on the long edge is
 * roughly 1 to 1.5 thousand model input tokens and 80 to 200 KB as JPEG. The image is never scaled
 * up. Pure JVM.
 */
public final class BrowserCapturePolicy {
  public static final int DEFAULT_MAX_EDGE = 1024;
  public static final int MIN_MAX_EDGE = 256;
  public static final int MAX_MAX_EDGE = 2048;
  public static final int DEFAULT_QUALITY = 70;

  private BrowserCapturePolicy() {}

  public static boolean validMaxEdge(int edge) {
    return edge >= MIN_MAX_EDGE && edge <= MAX_MAX_EDGE;
  }

  public static boolean validQuality(int quality) {
    return quality >= 30 && quality <= 90;
  }

  /** {width, height} after fitting the long edge into {@code maxEdge}, at least 1 px each. */
  public static int[] scaled(int width, int height, int maxEdge) {
    int edge = Math.max(width, height);
    if (edge <= maxEdge)
      return new int[] {width, height};
    double scale = (double) maxEdge / edge;
    return new int[] {
        Math.max(1, (int) Math.round(width * scale)), Math.max(1, (int) Math.round(height * scale))};
  }
}
