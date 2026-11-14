package ai.eliza.plugins.media;

/** A normalized selection in the upright, rotated photo, shared by preview and saved pixels. */
public final class PhotoCropRect {
  public final double x, y, width, height;

  public PhotoCropRect(double x, double y, double width, double height) {
    if (!Double.isFinite(x) || !Double.isFinite(y) || !Double.isFinite(width)
        || !Double.isFinite(height) || x < 0 || y < 0 || width <= 0 || height <= 0
        || x + width > 1 || y + height > 1)
      throw new IllegalArgumentException("Choose a crop rectangle inside the photo");
    this.x = x == 0 ? 0 : x;
    this.y = y == 0 ? 0 : y;
    this.width = width;
    this.height = height;
  }

  /** Includes every touched source pixel, with a minimum one-pixel result. */
  public int[] bounds(int imageWidth, int imageHeight) {
    if (imageWidth < 1 || imageHeight < 1)
      throw new IllegalArgumentException("Photo dimensions must be positive");
    int left = Math.min(imageWidth - 1, (int) Math.floor(x * imageWidth));
    int top = Math.min(imageHeight - 1, (int) Math.floor(y * imageHeight));
    int right = Math.min(imageWidth, (int) Math.ceil((x + width) * imageWidth));
    int bottom = Math.min(imageHeight, (int) Math.ceil((y + height) * imageHeight));
    return new int[] {left, top, Math.max(1, right - left), Math.max(1, bottom - top)};
  }

  /** Empty identifies an older edit that used only the boolean crop option. */
  public static String key(PhotoCropRect rect) {
    return rect == null ? "" : rect.x + ":" + rect.y + ":" + rect.width + ":" + rect.height;
  }
}
