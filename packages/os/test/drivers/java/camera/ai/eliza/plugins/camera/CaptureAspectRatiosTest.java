// spec/os/android/camera.md, "A preview binds its photo stream only at an aspect ratio the device lists"
package ai.eliza.plugins.camera;

import java.util.List;
import java.util.Objects;

public final class CaptureAspectRatiosTest {
  private static int checks;

  private static void equal(Object actual, Object expected) {
    checks++;
    if (!Objects.equals(actual, expected))
      throw new AssertionError("Check " + checks + ": " + actual + " != " + expected);
  }

  private static void refused(Object requested) {
    checks++;
    try {
      CaptureAspectRatios.parse(requested);
    } catch (IllegalArgumentException expected) {
      return;
    }
    throw new AssertionError("Check " + checks + ": accepted " + requested);
  }

  public static void main(String[] args) {
    equal(CaptureAspectRatios.SUPPORTED, List.of("4:3", "16:9"));
    equal(CaptureAspectRatios.parse(null), "4:3");
    equal(CaptureAspectRatios.parse("4:3"), "4:3");
    equal(CaptureAspectRatios.parse("16:9"), "16:9");
    for (Object requested : new Object[] {"1:1", "16/9", "", " 4:3", "4:3 ", "9:16", 1.5, 4.0 / 3})
      refused(requested);
    System.out.println("CaptureAspectRatiosTest checks: " + checks);
  }
}
