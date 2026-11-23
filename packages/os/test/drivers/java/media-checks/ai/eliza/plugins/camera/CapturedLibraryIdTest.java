package ai.eliza.plugins.camera;

public final class CapturedLibraryIdTest {
  private static int assertions;

  private static void equal(Object actual, Object expected) {
    assertions++;
    if (actual == null ? expected != null : !actual.equals(expected))
      throw new AssertionError(actual + " != " + expected);
  }

  public static void main(String[] args) {
    equal(CapturedLibraryId.image("external_primary", 42), "m:external_primary:i:42");
    equal(CapturedLibraryId.image("1a2b-3c4d", 7), "m:1a2b-3c4d:i:7");
    equal(CapturedLibraryId.image("external_primary", Long.MAX_VALUE), "m:external_primary:i:" + Long.MAX_VALUE);
    equal(CapturedLibraryId.image("external", 42), null);
    equal(CapturedLibraryId.image("internal", 42), null);
    equal(CapturedLibraryId.image(null, 42), null);
    equal(CapturedLibraryId.image("", 42), null);
    equal(CapturedLibraryId.image("external_primary", 0), null);
    equal(CapturedLibraryId.image("external_primary", -1), null);
    equal(CapturedLibraryId.image("a:b", 1), null);
    equal(CapturedLibraryId.image("a b", 1), null);
    equal(CapturedLibraryId.image("x".repeat(81), 1), null);
    equal(CapturedLibraryId.image("x".repeat(80), 1), "m:" + "x".repeat(80) + ":i:1");
    System.out.println(assertions + " assertions passed");
  }
}
