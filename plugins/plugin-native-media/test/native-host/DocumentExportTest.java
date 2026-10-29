import ai.eliza.plugins.media.DocumentExport;
import ai.eliza.plugins.media.PdfPageLimits;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;

/**
 * JVM tests of export rules and isolated-PDF bounds with synthetic values only. Not Android,
 * document-provider, PdfRenderer or isolated-process evidence.
 */
public final class DocumentExportTest {
  private static int checks;
  private static void check(boolean value, String label) {
    checks++;
    if (!value)
      throw new AssertionError("Check " + checks + ": " + label);
  }
  private interface Failing {
    void run() throws Exception;
  }
  private static void rejects(Failing body, String label) {
    checks++;
    try {
      body.run();
    } catch (IOException | IllegalArgumentException | ArithmeticException expected) {
      return;
    } catch (Exception error) {
      throw new AssertionError("Check " + checks + " (" + label + "): " + error);
    }
    throw new AssertionError("Check " + checks + " should have been rejected: " + label);
  }

  public static void main(String[] args) throws Exception {
    byte[] text = DocumentExport.utf8("Grüße\n");
    check(Arrays.equals(text, "Grüße\n".getBytes(StandardCharsets.UTF_8)), "exact UTF-8 bytes");
    check(DocumentExport.utf8("").length == 0, "empty text exports");
    check(DocumentExport.utf8("a".repeat(DocumentExport.TEXT_LIMIT)).length
            == DocumentExport.TEXT_LIMIT,
        "the limit itself is accepted");
    rejects(() -> DocumentExport.utf8(null), "missing text");
    rejects(() -> DocumentExport.utf8("a".repeat(DocumentExport.TEXT_LIMIT + 1)), "too many chars");
    rejects(() -> DocumentExport.utf8("é".repeat(DocumentExport.TEXT_LIMIT / 2 + 1)),
        "too many UTF-8 bytes");
    checks++;
    try {
      DocumentExport.utf8("lone \uD800 surrogate");
      throw new AssertionError("a lone surrogate must not be replaced");
    } catch (CharacterCodingException expected) {
    }

    check(DocumentExport.title("a/b\\c\u0007d", "Note").equals("a_b_c_d"), "path and control");
    check(DocumentExport.title("   ", "Note").equals("Note"), "blank title falls back");
    check(DocumentExport.title(null, "Scan").equals("Scan"), "missing title falls back");
    check(DocumentExport.title("x".repeat(150), "Note").length() == DocumentExport.TITLE_LIMIT,
        "title is cut");

    byte[] bytes = {1, 2, 3};
    DocumentExport.verify(new ByteArrayInputStream(bytes), bytes, 3);
    checks++;
    rejects(() -> DocumentExport.verify(new ByteArrayInputStream(new byte[] {1, 2}), bytes, 3),
        "short readback");
    rejects(() -> DocumentExport.verify(new ByteArrayInputStream(new byte[] {1, 2, 4}), bytes, 3),
        "changed readback");
    rejects(() -> DocumentExport.verify(new ByteArrayInputStream(new byte[] {1, 2, 3, 4}), bytes, 3),
        "readback past the limit");
    rejects(() -> DocumentExport.verify(null, bytes, 3), "missing readback");
    check(DocumentExport.failed(true) == DocumentExport.Outcome.UNVERIFIED
            && DocumentExport.failed(false) == DocumentExport.Outcome.FAILED,
        "an opened destination is never reported as untouched");
    check(DocumentExport.Outcome.EXPORTED.status.equals("exported")
            && DocumentExport.Outcome.UNVERIFIED.status.equals("unverified")
            && DocumentExport.Outcome.FAILED.status.equals("failed"),
        "bridge statuses");

    check(DocumentExport.validSegment("mail-attachments") && !DocumentExport.validSegment("..")
            && !DocumentExport.validSegment("a/b") && !DocumentExport.validSegment("")
            && !DocumentExport.validSegment(null),
        "handoff segments");
    check(DocumentExport.handoffPath(List.of("reviewed", "x.pdf"), "reviewed"), "handoff path");
    check(!DocumentExport.handoffPath(List.of("other", "x.pdf"), "reviewed")
            && !DocumentExport.handoffPath(List.of("reviewed"), "reviewed")
            && !DocumentExport.handoffPath(List.of("reviewed", "a", "b"), "reviewed")
            && !DocumentExport.handoffPath(List.of("reviewed", ""), "reviewed")
            && !DocumentExport.handoffPath(null, "reviewed"),
        "only one file directly under the provider path");

    check(PdfPageLimits.admitsRequest("x".repeat(36), 0)
            && !PdfPageLimits.admitsRequest("short", 0)
            && !PdfPageLimits.admitsRequest(null, 0)
            && !PdfPageLimits.admitsRequest("x".repeat(36), -1)
            && !PdfPageLimits.admitsRequest("x".repeat(36), PdfPageLimits.MAX_PAGES),
        "request admission");
    rejects(() -> PdfPageLimits.requireSource(0), "empty PDF");
    rejects(() -> PdfPageLimits.requireSource(PdfPageLimits.MAX_SOURCE_BYTES + 1), "large PDF");
    PdfPageLimits.requireSource(PdfPageLimits.MAX_SOURCE_BYTES);
    checks++;
    rejects(() -> PdfPageLimits.requirePage(3, 3), "page past the end");
    rejects(() -> PdfPageLimits.requirePage(PdfPageLimits.MAX_PAGES + 1, 0), "too many pages");
    int[] letter = PdfPageLimits.fit(612, 792);
    check(letter[0] <= PdfPageLimits.MAX_WIDTH && letter[1] <= PdfPageLimits.MAX_EDGE
            && (long) letter[0] * letter[1] <= PdfPageLimits.MAX_PIXELS,
        "a letter page fits");
    check(Math.abs(letter[0] / (double) letter[1] - 612 / 792d) < 0.01, "aspect ratio kept");
    int[] wide = PdfPageLimits.fit(20000, 10);
    check(wide[0] <= PdfPageLimits.MAX_WIDTH && wide[1] >= 1, "a very wide page keeps a row");
    int[] tiny = PdfPageLimits.fit(1, 1);
    check(tiny[0] >= 1 && tiny[1] >= 1 && (long) tiny[0] * tiny[1] <= PdfPageLimits.MAX_PIXELS,
        "a tiny page scales up within limits");
    rejects(() -> PdfPageLimits.fit(0, 10), "empty page");
    rejects(() -> PdfPageLimits.fit(20001, 10), "page larger than the point limit");
    check(PdfPageLimits.argbLength(10, 20) == 800, "ARGB length");
    rejects(() -> PdfPageLimits.argbLength(Integer.MAX_VALUE, 2), "ARGB overflow");

    int w = 600, h = 800;
    long size = (long) w * h * 4;
    PdfPageLimits.requireReply(true, true, 99001, 10001, w, h, 3, 1, 1, size);
    checks++;
    rejects(() -> PdfPageLimits.requireReply(false, true, 99001, 10001, w, h, 3, 1, 1, size),
        "not isolated");
    rejects(() -> PdfPageLimits.requireReply(true, false, 99001, 10001, w, h, 3, 1, 1, size),
        "network allowed");
    rejects(() -> PdfPageLimits.requireReply(true, true, 10001, 10001, w, h, 3, 1, 1, size),
        "same uid as the viewer");
    rejects(() -> PdfPageLimits.requireReply(true, true, 99001, 10001, w, h, 3, 2, 1, size),
        "a different page");
    rejects(() -> PdfPageLimits.requireReply(true, true, 99001, 10001, w, h, 3, 3, 3, size),
        "page past the count");
    rejects(() -> PdfPageLimits.requireReply(true, true, 99001, 10001, w, h, 3, 1, 1, size - 4),
        "pixel bytes disagree with the size");
    rejects(() -> PdfPageLimits.requireReply(true, true, 99001, 10001, 1537, 10, 3, 1, 1,
                1537L * 10 * 4),
        "edge past the limit");
    rejects(() -> PdfPageLimits.requireReply(true, true, 99001, 10001, 1536, 1536, 3, 1, 1,
                1536L * 1536 * 4),
        "area past the limit");
    rejects(() -> PdfPageLimits.requireReply(true, true, 99001, 10001, w, h, 0, 0, 0, size),
        "no pages");
    System.out.println(checks + " assertions passed");
  }
}
