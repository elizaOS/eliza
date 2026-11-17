package ai.eliza.plugins.media;

import java.util.Set;

/**
 * CSS reference filters in encoded sRGB; clip after each primitive, not one concatenated
 * matrix. Pure per-pixel math, independent of android.graphics, so JVM tests cover it.
 */
public final class PhotoFilterMath {
  public static final Set<String> NAMES =
      Set.of("none", "vivid", "warm", "cool", "mono", "fade", "noir");

  public static String validate(String name) {
    if (name == null || !NAMES.contains(name))
      throw new IllegalArgumentException("Unknown photo filter");
    return name;
  }

  /** One validated filter with its precomputed hue rotation. */
  public static final class Kernel {
    public final String name;
    private final double cos, sin;
    private final double[] p = new double[3];
    private Kernel(String name) {
      this.name = name;
      double angle = Math.toRadians(name.equals("warm") ? -8 : 14);
      cos = Math.cos(angle);
      sin = Math.sin(angle);
    }
    /** Filters one unpremultiplied ARGB pixel. Not thread-safe: one kernel per worker. */
    public int apply(int color) {
      int alpha = color >>> 24;
      if (alpha == 0)
        return 0;
      if (name.equals("none"))
        return color;
      p[0] = ((color >>> 16) & 255) / 255d;
      p[1] = ((color >>> 8) & 255) / 255d;
      p[2] = (color & 255) / 255d;
      switch (name) {
        case "vivid":
          saturation(p, 1.55);
          contrast(p, 1.08);
          break;
        case "warm":
          sepia(p);
          saturation(p, 1.35);
          hue(p, cos, sin);
          break;
        case "cool":
          saturation(p, 1.1);
          hue(p, cos, sin);
          brightness(p, 1.03);
          break;
        case "mono":
          gray(p);
          contrast(p, 1.05);
          break;
        case "fade":
          contrast(p, .78);
          brightness(p, 1.12);
          saturation(p, .75);
          break;
        case "noir":
          gray(p);
          contrast(p, 1.55);
          brightness(p, .88);
          break;
        default:
          throw new IllegalArgumentException("Unknown photo filter");
      }
      return (alpha << 24) | (channel(p[0], alpha) << 16) | (channel(p[1], alpha) << 8)
          | channel(p[2], alpha);
    }
  }

  public static Kernel kernel(String name) {
    return new Kernel(validate(name));
  }

  // Quantize once in Android's premultiplied storage domain, then express the
  // representable value for setPixels' unpremultiplied ARGB input.
  static int channel(double value, int alpha) {
    return Math.min(255, (int) Math.round(Math.round(value * alpha) * 255d / alpha));
  }
  private static double clip(double v) {
    return Math.max(0, Math.min(1, v));
  }
  private static void clamp(double[] p) {
    for (int i = 0; i < 3; i++) p[i] = clip(p[i]);
  }
  private static void brightness(double[] p, double amount) {
    for (int i = 0; i < 3; i++) p[i] *= amount;
    clamp(p);
  }
  private static void contrast(double[] p, double amount) {
    for (int i = 0; i < 3; i++) p[i] = (p[i] - .5) * amount + .5;
    clamp(p);
  }
  private static void saturation(double[] p, double t) {
    double r = p[0], g = p[1], b = p[2];
    p[0] = (.213 + .787 * t) * r + (.715 - .715 * t) * g + (.072 - .072 * t) * b;
    p[1] = (.213 - .213 * t) * r + (.715 + .285 * t) * g + (.072 - .072 * t) * b;
    p[2] = (.213 - .213 * t) * r + (.715 - .715 * t) * g + (.072 + .928 * t) * b;
    clamp(p);
  }
  private static void gray(double[] p) {
    double lum = .2126 * p[0] + .7152 * p[1] + .0722 * p[2];
    p[0] = p[1] = p[2] = clip(lum);
  }
  private static void sepia(double[] p) {
    double r = p[0], g = p[1], b = p[2], t = .3;
    p[0] = (1 - .607 * t) * r + .769 * t * g + .189 * t * b;
    p[1] = .349 * t * r + (1 - .314 * t) * g + .168 * t * b;
    p[2] = .272 * t * r + .534 * t * g + (1 - .869 * t) * b;
    clamp(p);
  }
  private static void hue(double[] p, double c, double s) {
    double r = p[0], g = p[1], b = p[2];
    p[0] = (.213 + .787 * c - .213 * s) * r + (.715 - .715 * c - .715 * s) * g
        + (.072 - .072 * c + .928 * s) * b;
    p[1] = (.213 - .213 * c + .143 * s) * r + (.715 + .285 * c + .140 * s) * g
        + (.072 - .072 * c - .283 * s) * b;
    p[2] = (.213 - .213 * c - .787 * s) * r + (.715 - .715 * c + .715 * s) * g
        + (.072 + .928 * c + .072 * s) * b;
    clamp(p);
  }
  private PhotoFilterMath() {}
}
