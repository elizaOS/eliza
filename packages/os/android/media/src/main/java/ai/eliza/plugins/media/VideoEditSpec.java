package ai.eliza.plugins.media;

/**
 * Immutable video-copy parameters. Matches the shared editor's clockwise,
 * centered 1.3x crop and even-sized, at-most-1920px preview geometry.
 */
public final class VideoEditSpec {
  public static final long MAX_BYTES = 100L * 1024 * 1024;
  public final long startMs, endMs;
  public final int rotation, width, height;
  public final boolean crop;

  public VideoEditSpec(double start, double end, int rotation, boolean crop, long durationMs,
      int sourceWidth, int sourceHeight) {
    if (durationMs <= 0 || durationMs > 300_000 || !Double.isFinite(start) || !Double.isFinite(end)
        || start < 0 || end > durationMs / 1000d + .05 || end - start < .1 - 1e-10
        || (rotation != 0 && rotation != 90 && rotation != 180 && rotation != 270)
        || sourceWidth <= 0 || sourceHeight <= 0 || (long) sourceWidth * sourceHeight > 32_000_000)
      throw new IllegalArgumentException(
          "Choose a video range of at least 0.1 seconds, within a five-minute video.");
    this.startMs = Math.round(start * 1000);
    // An end within 0.05 s of the duration, on either side, is the full video (the same tolerance
    // as the overshoot above).
    long requested = Math.round(end * 1000);
    this.endMs =
        Math.abs(durationMs - requested) <= 50 ? durationMs : Math.min(durationMs, requested);
    if (endMs - startMs < 100)
      throw new IllegalArgumentException("Choose a video range of at least 0.1 seconds.");
    this.rotation = rotation;
    this.crop = crop;
    double factor = crop ? 1.3 : 1, sw = sourceWidth / factor, sh = sourceHeight / factor;
    double scale = Math.min(1, 1920 / Math.max(sw, sh));
    boolean rotated = rotation % 180 != 0;
    width = Math.max(2, (int) Math.round((rotated ? sh : sw) * scale / 2) * 2);
    height = Math.max(2, (int) Math.round((rotated ? sw : sh) * scale / 2) * 2);
  }

  public boolean unchanged(long durationMs) {
    return startMs == 0 && endMs == durationMs && rotation == 0 && !crop;
  }
  public String binding() {
    return startMs + ":" + endMs + ":" + rotation + ":" + crop + ":" + width + ":" + height;
  }
}
