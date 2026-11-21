package ai.eliza.plugins.camera;

import java.util.List;

/** The photo aspect ratios `startPreview` accepts as `captureAspectRatio`, reported by `getDevices`. */
final class CaptureAspectRatios {
  /** CameraX selects photo streams only at these ratios; 4:3 is the default. */
  static final List<String> SUPPORTED = List.of("4:3", "16:9");

  private CaptureAspectRatios() {}

  /** The requested ratio, or 4:3 when none was given; throws for any other value. */
  static String parse(Object value) {
    if (value == null) return SUPPORTED.get(0);
    if (value instanceof String && SUPPORTED.contains(value)) return (String) value;
    throw new IllegalArgumentException(
        "captureAspectRatio must be one of " + String.join(", ", SUPPORTED));
  }
}
