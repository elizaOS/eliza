package ai.eliza.plugins.media;

import android.graphics.Bitmap;
import java.util.function.BooleanSupplier;

/** Applies a {@link PhotoFilterMath} filter row by row, honoring cancellation. */
public final class PhotoFilter {
  public static String validate(String name) {
    return PhotoFilterMath.validate(name);
  }

  public static Bitmap apply(Bitmap input, String name, BooleanSupplier cancelled) {
    PhotoFilterMath.Kernel kernel = PhotoFilterMath.kernel(name);
    if (name.equals("none"))
      return input;
    Bitmap out = Bitmap.createBitmap(input.getWidth(), input.getHeight(), Bitmap.Config.ARGB_8888);
    int[] row = new int[input.getWidth()];
    try {
      for (int y = 0; y < input.getHeight(); y++) {
        if (cancelled.getAsBoolean())
          throw new IllegalStateException("Photo editor closed");
        input.getPixels(row, 0, row.length, 0, y, row.length, 1);
        for (int x = 0; x < row.length; x++) row[x] = kernel.apply(row[x]);
        out.setPixels(row, 0, row.length, 0, y, row.length, 1);
      }
      return out;
    } catch (RuntimeException e) {
      out.recycle();
      throw e;
    }
  }
  private PhotoFilter() {}
}
