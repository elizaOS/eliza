package ai.eliza.plugins.media;

import static org.junit.Assert.*;

import org.junit.Test;

/** A kept PDF copy serves the next pages only while it is still the selected source. */
public final class PdfSourceCopyTest {
  private static final String A = "00000000-0000-4000-8000-000000000001";
  private static final String B = "00000000-0000-4000-8000-000000000002";

  @Test public void nextPageOfTheSameUnchangedSourceReusesTheCopy() {
    PdfSourceCopy copy = new PdfSourceCopy();
    assertFalse(copy.reusable(A, 1000, 7, 0));
    copy.kept(A, 1000, 7);
    assertEquals(A, copy.id());
    assertTrue(copy.reusable(A, 1000, 7, 1000));
  }

  @Test public void changedSourceOtherSelectionOrMissingFileCopiesAgain() {
    PdfSourceCopy copy = new PdfSourceCopy();
    copy.kept(A, 1000, 7);
    assertFalse("modified elsewhere", copy.reusable(A, 1000, 8, 1000));
    assertFalse("resized elsewhere", copy.reusable(A, 1200, 7, 1000));
    assertFalse("copy removed by forget", copy.reusable(A, 1000, 7, 0));
    assertFalse("another selection", copy.reusable(B, 1000, 7, 1000));
  }

  @Test public void providerWithoutSizeOrTimeKeepsNothing() {
    PdfSourceCopy copy = new PdfSourceCopy();
    copy.kept(A, 1000, 7);
    copy.kept(A, -1, -1);
    assertNull(copy.id());
    assertFalse(copy.reusable(A, -1, -1, 0));
    copy.kept(B, 1000, 0);
    assertNull(copy.id());
  }
}
