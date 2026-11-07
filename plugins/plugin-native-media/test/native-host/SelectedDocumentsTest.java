import ai.eliza.plugins.media.DocumentBytes;
import ai.eliza.plugins.media.SelectedPhotoCopy;
import ai.eliza.plugins.media.SourceReferences;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * JVM tests of exact selected-photo copies, document byte rules and source reference counting with
 * synthetic sources only. Not Android, provider or grant evidence.
 */
public final class SelectedDocumentsTest {
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
    } catch (IOException | IllegalArgumentException | SecurityException expected) {
      return;
    } catch (Exception error) {
      throw new AssertionError("Check " + checks + " (" + label + "): " + error);
    }
    throw new AssertionError("Check " + checks + " should have been rejected: " + label);
  }

  static SelectedPhotoCopy.Metadata metadata(
      String name, String mime, long size, String revision, String identity) {
    return new SelectedPhotoCopy.Metadata(name, mime, size, revision, identity);
  }
  static final SelectedPhotoCopy.Metadata GOOD =
      metadata("photo.png", "image/png", 99, "revision", "volume:91");
  static final class Source implements SelectedPhotoCopy.Source {
    byte[] data = {1, 2, 3};
    int reads, opened;
    boolean closed;
    SelectedPhotoCopy.Metadata first = GOOD, last = GOOD;
    public SelectedPhotoCopy.Metadata inspect() {
      return reads++ == 0 ? first : last;
    }
    public InputStream open() {
      opened++;
      return new ByteArrayInputStream(data) {
        public void close() {
          closed = true;
        }
      };
    }
  }
  static String ref(char c) {
    return "a1:" + String.valueOf(c).repeat(64);
  }

  public static void main(String[] args) throws Exception {
    // Exact readable bytes, hashed and closed; any metadata change during the copy is refused.
    Source source = new Source();
    SelectedPhotoCopy.Copy copy = SelectedPhotoCopy.read(source, () -> {});
    check(Arrays.equals(copy.bytes, source.data) && source.closed
            && copy.sha256.equals(
                "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81"),
        "exact readable bytes, hash and close");
    for (SelectedPhotoCopy.Metadata changed : new SelectedPhotoCopy.Metadata[] {
             metadata("other.png", "image/png", 99, "revision", "volume:91"),
             metadata("photo.png", "image/jpeg", 99, "revision", "volume:91"),
             metadata("photo.png", "image/png", 98, "revision", "volume:91"),
             metadata("photo.png", "image/png", 99, "new", "volume:91"),
             metadata("photo.png", "image/png", 99, "revision", "volume:92")}) {
      Source item = new Source();
      item.last = changed;
      rejects(() -> SelectedPhotoCopy.read(item, () -> {}), "changed source");
      check(item.closed, "changed source is closed");
    }
    Source revoked = new Source();
    int[] guards = {0};
    rejects(() -> SelectedPhotoCopy.read(revoked, () -> {
      if (++guards[0] == 3)
        throw new SecurityException();
    }), "revoked mid-copy");
    check(revoked.closed, "revoked source is closed");
    Source oversized = new Source();
    oversized.data = new byte[SelectedPhotoCopy.MAX_BYTES + 1];
    rejects(() -> SelectedPhotoCopy.read(oversized, () -> {}), "oversized");
    check(oversized.closed, "oversized source is closed");
    Source empty = new Source();
    empty.data = new byte[0];
    rejects(() -> SelectedPhotoCopy.read(empty, () -> {}), "empty");
    for (SelectedPhotoCopy.Metadata invalid :
        new SelectedPhotoCopy.Metadata[] {metadata("../photo.png", "image/png", 99, "r", "i"),
            metadata("photo.gif", "image/gif", 99, "r", "i"),
            metadata("photo.png", "image/png", SelectedPhotoCopy.MAX_BYTES + 1L, "r", "i"),
            metadata("photo.png", "image/png", 99, "", "i")}) {
      Source item = new Source();
      item.first = invalid;
      rejects(() -> SelectedPhotoCopy.read(item, () -> {}), "invalid metadata");
      check(item.opened == 0, "invalid source is never opened");
    }
    // A completed copy still needs current delivery authority.
    boolean[] current = {true};
    int[] delivered = {0}, rejected = {0};
    Runnable queued = () -> SelectedPhotoCopy.publish(() -> {
      if (!current[0])
        throw new SecurityException();
    }, () -> delivered[0]++, () -> rejected[0]++);
    current[0] = false;
    queued.run();
    check(delivered[0] == 0 && rejected[0] == 1, "late publication is refused");
    current[0] = true;
    queued.run();
    check(delivered[0] == 1 && rejected[0] == 1, "current publication is delivered");

    // Document bytes: signatures must agree with the declared type and name.
    byte[] pdf = "%PDF-1.7\nreal export bytes\n%%EOF".getBytes(StandardCharsets.UTF_8);
    DocumentBytes.validate("report.pdf", "application/pdf", pdf);
    DocumentBytes.validate(
        "pixel.png", "image/png", new byte[] {(byte) 137, 80, 78, 71, 13, 10, 26, 10});
    DocumentBytes.validate(
        "photo.JPG", "image/jpeg", new byte[] {(byte) 255, (byte) 216, (byte) 255});
    DocumentBytes.validate(
        "image.webp", "image/webp", "RIFF\0\0\0\0WEBPVP8 ".getBytes(StandardCharsets.US_ASCII));
    DocumentBytes.validate("notes.txt", "text/plain", "Grüße\n".getBytes(StandardCharsets.UTF_8));
    rejects(()
                -> DocumentBytes.validate("wrong.pdf", "application/pdf", "not PDF".getBytes()),
        "wrong signature");
    rejects(() -> DocumentBytes.validate("report.png", "application/pdf", pdf), "wrong extension");
    rejects(()
                -> DocumentBytes.validate(
                    "large.pdf", "application/pdf", new byte[DocumentBytes.MAX_BYTES + 1]),
        "oversize");
    rejects(() -> DocumentBytes.validate("../escape.pdf", "application/pdf", pdf), "traversal");
    rejects(() -> DocumentBytes.validate("report.pdf", null, pdf), "missing type");
    rejects(()
                -> DocumentBytes.validate("bad.txt", "text/plain", new byte[] {(byte) 0xc3}),
        "malformed UTF-8");
    rejects(() -> DocumentBytes.validate("nul.txt", "text/plain", new byte[] {65, 0}), "NUL text");
    DocumentBytes.validateOpaque("archive.bin", new byte[] {0, 1, 2});
    rejects(() -> DocumentBytes.validateOpaque("..", new byte[] {0}), "opaque dot name");
    rejects(() -> DocumentBytes.validateOpaque("a/b", new byte[] {0}), "opaque path");
    check(DocumentBytes.opaqueMime("Application/ZIP").equals("application/zip"), "opaque type");
    check(DocumentBytes.opaqueMime("bad type").equals("application/octet-stream"), "fallback");
    check(DocumentBytes.opaqueMime(null).equals("application/octet-stream"), "missing type");
    check(Arrays.equals(DocumentBytes.read(new ByteArrayInputStream(pdf)), pdf), "bounded read");
    rejects(
        ()
            -> DocumentBytes.read(new ByteArrayInputStream(new byte[DocumentBytes.MAX_BYTES + 1])),
        "read is refused, never truncated");
    rejects(() -> DocumentBytes.read(null), "missing stream");
    String encoded = Base64.getEncoder().encodeToString(pdf);
    check(Arrays.equals(pdf, DocumentBytes.pdf(encoded)), "PDF payload");
    for (String value : new String[] {null, "", "broken", encoded + "!",
             Base64.getEncoder().encodeToString("not a pdf".getBytes(StandardCharsets.UTF_8))})
      rejects(() -> DocumentBytes.pdf(value), "PDF payload " + value);
    rejects(() -> DocumentBytes.pdf("A".repeat(11184816)), "PDF payload size");
    check(DocumentBytes.sha256(new byte[] {1, 2, 3})
              .equals("039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81"),
        "hash");

    // Source references: a grant is kept while any saved item names it, released with the last.
    String doc = "content://provider/document/report.pdf",
           photo = "content://provider/document/photo.png";
    check(SourceReferences.reference(doc).equals(
              "a1:" + DocumentBytes.sha256(doc.getBytes(StandardCharsets.UTF_8))),
        "reference names the URI hash");
    check(SourceReferences.valid(SourceReferences.reference(doc)), "reference shape");
    rejects(
        () -> SourceReferences.reference("c".repeat(SourceReferences.URI_LIMIT + 1)), "long URI");
    rejects(() -> SourceReferences.reference(""), "empty URI");
    Map<String, Object> refs = new LinkedHashMap<>();
    refs.put(ref('a'), doc);
    refs.put(ref('b'), doc);
    refs.put(ref('c'), photo);
    refs.put("legacy-key", "content://other");
    check(SourceReferences.referenced(refs, doc) && SourceReferences.referenced(refs, photo),
        "referenced documents keep their grant");
    check(!SourceReferences.referenced(refs, "content://other"), "only a1: references count");
    check(!SourceReferences.referenced(refs, null), "no uri");
    long now = 1_800_000_000_000L;
    Map<String, Object> old = new HashMap<>();
    for (String key : refs.keySet()) old.put(key, now - SourceReferences.GRACE_MS);
    List<String> drop = SourceReferences.unreferenced(refs, Set.of(ref('a'), ref('b')), old, now);
    check(drop.equals(List.of(ref('c'))), "the deleted item's reference is pruned");
    check(SourceReferences.orphaned(refs, drop).equals(Set.of(photo)), "its grant is released");
    drop = SourceReferences.unreferenced(refs, Set.of(ref('a'), ref('c')), old, now);
    check(drop.equals(List.of(ref('b'))) && SourceReferences.orphaned(refs, drop).isEmpty(),
        "a document another item names keeps its grant");
    drop = SourceReferences.unreferenced(refs, Set.of(), old, now);
    check(drop.size() == 3 && !drop.contains("legacy-key"), "other keys are left alone");
    check(SourceReferences.orphaned(refs, drop).equals(Set.of(doc, photo)), "both are released");
    // An unsaved content-question reference is kept for three days after it was last retained.
    check(SourceReferences.GRACE_MS == 3L * 24 * 60 * 60 * 1000, "three-day grace");
    Map<String, Object> recent = new HashMap<>(old);
    recent.put(ref('c'), now - SourceReferences.GRACE_MS + 60_000);
    check(!SourceReferences.unreferenced(refs, Set.of(), recent, now).contains(ref('c')),
        "inside the grace period");
    recent.put(ref('c'), now - SourceReferences.GRACE_MS);
    check(SourceReferences.unreferenced(refs, Set.of(), recent, now).contains(ref('c')),
        "after the grace period");
    check(SourceReferences.unreferenced(refs, Set.of(), recent, now, 0).size() == 3,
        "a host-chosen grace");
    rejects(() -> SourceReferences.unreferenced(refs, Set.of(), recent, now, -1), "negative grace");
    recent.remove(ref('c'));
    check(!SourceReferences.unreferenced(refs, Set.of(), recent, now).contains(ref('c'))
            && SourceReferences.unseeded(refs, recent, now).equals(List.of(ref('c'))),
        "a reference without a time is kept and seeded");
    recent.put(ref('c'), now + 60_000);
    check(SourceReferences.unseeded(refs, recent, now).equals(List.of(ref('c'))),
        "a future time is re-seeded");
    recent.put(ref('c'), "not a time");
    check(SourceReferences.unseeded(refs, recent, now).equals(List.of(ref('c'))),
        "an unreadable time is re-seeded");
    check(SourceReferences.unseeded(refs, old, now).isEmpty(), "timed references are not seeded");
    Map<String, Object> full = new LinkedHashMap<>(), fullTimes = new HashMap<>();
    for (int i = 0; i < SourceReferences.LIMIT; i++) {
      full.put("a1:" + String.format("%064x", i), "content://provider/document/" + i);
      fullTimes.put("a1:" + String.format("%064x", i), now - SourceReferences.GRACE_MS - i);
    }
    check(SourceReferences.unreferenced(full, Set.of(), fullTimes, now).size()
            == SourceReferences.LIMIT,
        "a full map of deleted items' links is emptied");
    check(!SourceReferences.valid("a1:XYZ")
            && !SourceReferences.valid("b1:"
                + "a".repeat(64))
            && !SourceReferences.valid(null),
        "a1: shape");
    System.out.println(checks + " assertions passed");
  }
}
