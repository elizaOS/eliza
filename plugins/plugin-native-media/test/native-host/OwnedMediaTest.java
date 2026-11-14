import ai.eliza.plugins.media.MediaBytes;
import ai.eliza.plugins.media.OwnedMediaConfig;
import ai.eliza.plugins.media.PhotoFilterMath;
import ai.eliza.plugins.media.PhotoCropRect;
import java.io.ByteArrayInputStream;
import java.io.IOException;

/** JVM tests with synthetic pixels and identities only; no Android framework. */
public final class OwnedMediaTest {
  private static int checks;
  private static void check(boolean value) {
    checks++;
    if (!value)
      throw new AssertionError("Check " + checks);
  }
  private interface Failing {
    void run() throws Exception;
  }
  private static void rejects(Class<? extends Exception> type, Failing body) {
    checks++;
    try {
      body.run();
    } catch (Exception error) {
      if (type.isInstance(error))
        return;
      throw new AssertionError("Check " + checks + ": " + error);
    }
    throw new AssertionError("Check " + checks + " should have been rejected");
  }
  private static int argb(int a, int r, int g, int b) {
    return (a << 24) | (r << 16) | (g << 8) | b;
  }
  private static int r(int c) {
    return (c >>> 16) & 255;
  }
  private static int g(int c) {
    return (c >>> 8) & 255;
  }
  private static int b(int c) {
    return c & 255;
  }

  public static void main(String[] args) throws Exception {
    // Configuration: host-owned names and placement only, validated.
    OwnedMediaConfig config = OwnedMediaConfig.builder("host")
                                  .edits("Pictures/Host App/Edits/", "Host-edit-")
                                  .captures("Pictures/", "SCAN_")
                                  .build();
    String op = "123e4567-e89b-42d3-a456-426614174000";
    check(config.preferences("photo-edit-results").equals("host-photo-edit-results"));
    check(config.editName(op).equals("Host-edit-" + op + ".png"));
    check(config.captureName(op).equals("SCAN_" + op + ".jpg"));
    check(config.editRelativePath.equals("Pictures/Host App/Edits/"));
    rejects(IllegalArgumentException.class,
        () -> config.editName("123E4567-E89B-42D3-A456-426614174000"));
    rejects(IllegalArgumentException.class, () -> config.editName("../../etc"));
    rejects(IllegalArgumentException.class, () -> config.editName(null));
    rejects(IllegalArgumentException.class, () -> config.preferences("../x"));
    rejects(IllegalArgumentException.class, () -> OwnedMediaConfig.builder("Host"));
    rejects(IllegalArgumentException.class,
        () -> OwnedMediaConfig.builder("host").edits("Download/", "x"));
    rejects(IllegalArgumentException.class,
        () -> OwnedMediaConfig.builder("host").edits("Pictures/../Download/", "x"));
    rejects(IllegalArgumentException.class,
        () -> OwnedMediaConfig.builder("host").edits("Pictures/Edits", "x"));
    rejects(IllegalArgumentException.class,
        () -> OwnedMediaConfig.builder("host").edits("Pictures/Edits/", "a/b"));
    rejects(IllegalStateException.class,
        () -> OwnedMediaConfig.builder("host").edits("Pictures/", "x").build());

    // A chosen off-center region survives the same mapping at preview and full resolution.
    PhotoCropRect crop = new PhotoCropRect(.1, .2, .4, .3);
    check(java.util.Arrays.equals(crop.bounds(100, 200), new int[] {10, 40, 40, 60}));
    check(java.util.Arrays.equals(crop.bounds(1000, 2000), new int[] {100, 400, 400, 600}));
    check(java.util.Arrays.equals(crop.bounds(200, 100), new int[] {20, 20, 80, 30}));
    check(java.util.Arrays.equals(new PhotoCropRect(0, 0, 1, 1).bounds(1, 1), new int[] {0, 0, 1, 1}));
    check(java.util.Arrays.equals(new PhotoCropRect(.999, .999, .001, .001).bounds(2, 2), new int[] {1, 1, 1, 1}));
    check(!PhotoCropRect.key(crop).equals(PhotoCropRect.key(new PhotoCropRect(.2, .2, .4, .3))));
    check(PhotoCropRect.key(null).equals(""));
    rejects(IllegalArgumentException.class, () -> new PhotoCropRect(Double.NaN, 0, .5, .5));
    rejects(IllegalArgumentException.class, () -> new PhotoCropRect(0, 0, Double.POSITIVE_INFINITY, .5));
    rejects(IllegalArgumentException.class, () -> new PhotoCropRect(-.1, 0, .5, .5));
    rejects(IllegalArgumentException.class, () -> new PhotoCropRect(.8, 0, .3, .5));
    rejects(IllegalArgumentException.class, () -> new PhotoCropRect(0, .8, .5, .3));
    rejects(IllegalArgumentException.class, () -> new PhotoCropRect(0, 0, 0, .5));
    rejects(IllegalArgumentException.class, () -> crop.bounds(0, 200));

    // Filters: validated names, identity for none, transparent stays transparent.
    rejects(IllegalArgumentException.class, () -> PhotoFilterMath.kernel("sepia"));
    rejects(IllegalArgumentException.class, () -> PhotoFilterMath.kernel(null));
    int sample = argb(255, 200, 100, 50);
    check(PhotoFilterMath.kernel("none").apply(sample) == sample);
    for (String name : PhotoFilterMath.NAMES)
      check(PhotoFilterMath.kernel(name).apply(argb(0, 9, 9, 9)) == 0);
    // Mono and noir are gray; noir increases contrast around mid-gray.
    int mono = PhotoFilterMath.kernel("mono").apply(sample);
    check(r(mono) == g(mono) && g(mono) == b(mono));
    int dark = PhotoFilterMath.kernel("noir").apply(argb(255, 60, 60, 60)),
        light = PhotoFilterMath.kernel("noir").apply(argb(255, 200, 200, 200));
    check(r(dark) < 60 && r(light) > 200 * .88 - 1);
    // Vivid pushes saturation: the channel spread grows; fade reduces it.
    int vivid = PhotoFilterMath.kernel("vivid").apply(sample),
        fade = PhotoFilterMath.kernel("fade").apply(sample);
    check(r(vivid) - b(vivid) > 150);
    check(r(fade) - b(fade) < 150);
    // Warm favors red over blue; cool rotates the opposite way.
    int warm = PhotoFilterMath.kernel("warm").apply(argb(255, 128, 128, 128)),
        cool = PhotoFilterMath.kernel("cool").apply(argb(255, 128, 128, 128));
    check(r(warm) > b(warm));
    check(b(cool) >= r(cool) - 1);
    // Every output channel stays within 0..255 and alpha is preserved.
    for (String name : PhotoFilterMath.NAMES)
      for (int c : new int[] {argb(255, 255, 255, 255), argb(255, 0, 0, 0), argb(128, 255, 0, 255),
               argb(1, 3, 250, 7)}) {
        int out = PhotoFilterMath.kernel(name).apply(c);
        check((out >>> 24) == (c >>> 24));
      }

    // Readback: exact bytes only.
    byte[] bytes = "%PDF-owned".getBytes("UTF-8");
    MediaBytes.verify(new ByteArrayInputStream(bytes), bytes);
    check(true);
    rejects(IOException.class,
        () -> MediaBytes.verify(new ByteArrayInputStream("%PDF-owneD".getBytes("UTF-8")), bytes));
    rejects(IOException.class,
        () -> MediaBytes.verify(new ByteArrayInputStream("%PDF".getBytes("UTF-8")), bytes));
    rejects(IOException.class,
        () -> MediaBytes.verify(new ByteArrayInputStream("%PDF-owned!".getBytes("UTF-8")), bytes));
    rejects(IOException.class, () -> MediaBytes.verify(null, bytes));
    System.out.println(checks + " assertions passed");
  }
}
