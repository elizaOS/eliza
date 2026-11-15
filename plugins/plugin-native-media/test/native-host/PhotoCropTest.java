import ai.eliza.plugins.media.PhotoCrop;
import java.util.Arrays;

/** Plain-JVM checks for the crop rectangle of a photo edit. */
public final class PhotoCropTest {
  private static int assertions;

  private static void check(boolean condition, String message) {
    assertions++;
    if (!condition)
      throw new AssertionError(message);
  }

  private static void pixels(PhotoCrop crop, int width, int height, int... expected) {
    int[] actual = crop.pixels(width, height);
    check(Arrays.equals(actual, expected),
        "expected " + Arrays.toString(expected) + " got " + Arrays.toString(actual));
  }

  private static void refused(double x, double y, double width, double height) {
    try {
      PhotoCrop.rect(x, y, width, height);
    } catch (IllegalArgumentException expected) {
      assertions++;
      return;
    }
    throw new AssertionError("accepted " + x + "," + y + "," + width + "," + height);
  }

  public static void main(String[] args) {
    // The plain flag keeps its meaning: the fixed centered crop, each side divided by 1.3.
    check(PhotoCrop.of(false) == PhotoCrop.NONE && !PhotoCrop.NONE.enabled(), "no crop");
    check(PhotoCrop.of(true) == PhotoCrop.CENTER && PhotoCrop.CENTER.enabled(), "fixed crop");
    pixels(PhotoCrop.CENTER, 1300, 650, 150, 75, 1000, 500);
    pixels(PhotoCrop.CENTER, 4000, 3000, 462, 346, 3076, 2307);
    pixels(PhotoCrop.CENTER, 1, 1, 0, 0, 1, 1);
    check(PhotoCrop.CENTER.rectKey().isEmpty() && PhotoCrop.NONE.rectKey().isEmpty(),
        "a record without a rectangle is the plain flag");

    // A chosen rectangle keeps exactly that part of the rotated photo.
    PhotoCrop chosen = PhotoCrop.rect(0.25, 0.1, 0.5, 0.4);
    check(chosen.enabled(), "a rectangle crops");
    pixels(chosen, 4000, 3000, 1000, 300, 2000, 1200);
    pixels(PhotoCrop.rect(0.5, 0.5, 0.5, 0.5), 101, 51, 51, 26, 50, 25);
    pixels(PhotoCrop.rect(0, 0, 1, 0.5), 640, 480, 0, 0, 640, 240);
    // Never empty, never outside the photo.
    pixels(PhotoCrop.rect(0.999, 0.999, 0.001, 0.001), 10, 10, 9, 9, 1, 1);
    pixels(PhotoCrop.rect(0.4, 0.4, 0.0001, 0.0001), 10, 10, 4, 4, 1, 1);
    // A renderer's rounding at the far edge is the edge.
    pixels(PhotoCrop.rect(0.1, 0.7, 0.9 + 1e-12, 0.3 + 1e-12), 1000, 1000, 100, 700, 900, 300);
    check(PhotoCrop.rect(0, 0, 1, 1) == PhotoCrop.NONE, "the whole photo is no crop");

    // The stored identity tells rectangles apart and from the fixed crop.
    check(chosen.rectKey().equals(PhotoCrop.rect(0.25, 0.1, 0.5, 0.4).rectKey()), "same rectangle");
    check(!chosen.rectKey().equals(PhotoCrop.rect(0.25, 0.1, 0.5, 0.41).rectKey()),
        "different rectangle");
    check(!chosen.rectKey().isEmpty(), "a rectangle is stored");

    refused(-0.01, 0, 0.5, 0.5);
    refused(0, 0, 0, 0.5);
    refused(0, 0, 0.5, -1);
    refused(0.6, 0, 0.5, 0.5);
    refused(0, 0.2, 0.5, 0.9);
    refused(Double.NaN, 0, 0.5, 0.5);
    refused(0, 0, Double.POSITIVE_INFINITY, 0.5);
    refused(0, 0, 0.5, Double.NaN);
    refused(1, 0, 1e-12, 0.5);
    refused(0, 1, 0.5, 1e-12);
    refused(1 + 1e-12, 0, 1e-12, 0.5);
    refused(0, 1 + 1e-12, 0.5, 1e-12);

    System.out.println(assertions + " assertions passed");
  }
}
