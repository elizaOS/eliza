package ai.eliza.plugins.media;

/**
 * The part of a photo an edit keeps. {@link #NONE} keeps all of it. {@link #CENTER} is the fixed
 * centered crop (each side divided by 1.3) that a plain {@code crop: true} request always meant.
 * {@link #rect} keeps a rectangle the person chose, given as fractions (0 to 1) of the photo
 * <em>after</em> its rotation, with the origin at the top-left corner. Pure JVM; no Android types.
 */
public final class PhotoCrop {
  public static final PhotoCrop NONE = new PhotoCrop(false, 0, 0, 1, 1);
  public static final PhotoCrop CENTER = new PhotoCrop(true, 0, 0, 1, 1);
  /** The fixed crop divides each side by this. */
  private static final double CENTER_DIVISOR = 1.3;

  /** Tolerance for a renderer's rounding when a rectangle reaches the photo's far edge. */
  private static final double EDGE = 1e-9;

  private final boolean center;
  public final double x, y, width, height;

  private PhotoCrop(boolean center, double x, double y, double width, double height) {
    this.center = center;
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
  }

  /** The request's plain {@code crop} flag: the fixed centered crop, or none. */
  public static PhotoCrop of(boolean crop) {
    return crop ? CENTER : NONE;
  }

  /**
   * A chosen rectangle. Every value is a finite fraction of the rotated photo; the rectangle has
   * an area and lies inside the photo. The whole photo is {@link #NONE}.
   */
  public static PhotoCrop rect(double x, double y, double width, double height) {
    if (!(x >= 0 && x < 1 && y >= 0 && y < 1 && width > 0 && height > 0 && x + width <= 1 + EDGE
            && y + height <= 1 + EDGE))
      throw new IllegalArgumentException("Choose a crop area inside the photo");
    width = Math.min(width, 1 - x);
    height = Math.min(height, 1 - y);
    if (x == 0 && y == 0 && width == 1 && height == 1)
      return NONE;
    return new PhotoCrop(false, x, y, width, height);
  }

  /** Whether any part of the photo is removed. */
  public boolean enabled() {
    return center || this != NONE;
  }

  /**
   * The chosen rectangle as stored text, or the empty string for {@link #NONE} and
   * {@link #CENTER}. Equal text means the same rectangle; a record saved before rectangles
   * existed has none.
   */
  public String rectKey() {
    return center || this == NONE ? "" : x + "," + y + "," + width + "," + height;
  }

  /** The kept pixels of a rotated photo: left, top, width, height. Never empty. */
  public int[] pixels(int photoWidth, int photoHeight) {
    if (photoWidth < 1 || photoHeight < 1)
      throw new IllegalArgumentException("Photo has no pixels");
    if (center) {
      int w = Math.max(1, (int) Math.floor(photoWidth / CENTER_DIVISOR)),
          h = Math.max(1, (int) Math.floor(photoHeight / CENTER_DIVISOR));
      return new int[] {(photoWidth - w) / 2, (photoHeight - h) / 2, w, h};
    }
    int left = Math.min(photoWidth - 1, (int) Math.round(x * photoWidth)),
        top = Math.min(photoHeight - 1, (int) Math.round(y * photoHeight));
    int right = Math.min(photoWidth, Math.max(left + 1, (int) Math.round((x + width) * photoWidth))),
        bottom = Math.min(photoHeight, Math.max(top + 1, (int) Math.round((y + height) * photoHeight)));
    return new int[] {left, top, right - left, bottom - top};
  }
}
