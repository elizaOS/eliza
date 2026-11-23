package ai.eliza.plugins.camera;

import java.util.List;

public final class CaptureAspectRatiosTest {
  private static void equal(Object actual, Object expected) {
    if (!actual.equals(expected)) throw new AssertionError(actual + " != " + expected);
  }

  private static void rejects(Object value) {
    try {
      CaptureAspectRatios.parse(value);
    } catch (IllegalArgumentException expected) {
      return;
    }
    throw new AssertionError("accepted " + value);
  }

  public static void main(String[] args) {
    equal(CaptureAspectRatios.SUPPORTED, List.of("4:3", "16:9"));
    equal(CaptureAspectRatios.parse(null), "4:3");
    equal(CaptureAspectRatios.parse("4:3"), "4:3");
    equal(CaptureAspectRatios.parse("16:9"), "16:9");
    rejects("1:1");
    rejects("16/9");
    rejects("");
    rejects(1.5);
    System.out.println("CaptureAspectRatiosTest passed");
  }
}
