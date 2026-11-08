package ai.eliza.plugins.media;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Random;
import java.util.concurrent.atomic.AtomicInteger;

/** Host-JVM checks of the folder-tree capability session. Not Android or provider evidence. */
public final class FolderSessionTest {
  private static int checks;

  private static void check(boolean value, String label) {
    checks++;
    if (!value) throw new AssertionError("Check " + checks + ": " + label);
  }

  private static void rejects(Runnable body, String label) {
    try {
      body.run();
    } catch (RuntimeException expected) {
      checks++;
      return;
    }
    throw new AssertionError("Expected refusal: " + label);
  }

  /** The (location, parent) index answers exactly what a scan of the live entries would. */
  private static void indexMatchesScan() {
    AtomicInteger next = new AtomicInteger();
    FolderSession<String> session = new FolderSession<>(64, 40, () -> "s" + next.incrementAndGet());
    FolderSession.Entry<String> root = session.root("r");
    List<FolderSession.Entry<String>> issued = new ArrayList<>();
    issued.add(root);
    List<String> folders = new ArrayList<>(List.of(root.id));
    Random random = new Random(7);
    for (int step = 0; step < 2000; step++) {
      String parent = folders.get(random.nextInt(folders.size()));
      if (session.get(parent) == null) continue;
      String location = "r/" + random.nextInt(48);
      FolderSession.Entry<String> scanned = null;
      for (FolderSession.Entry<String> item : issued)
        if (session.get(item.id) == item
            && item.location().equals(location)
            && Objects.equals(item.parent, parent)) scanned = item;
      int roll = random.nextInt(10);
      if (roll == 0 && scanned != null && scanned != root) {
        session.remove(scanned.id);
        continue;
      }
      if (roll == 1 && scanned != null && scanned != root) {
        session.renamed(scanned, location + "-" + step);
        continue;
      }
      FolderSession.Entry<String> found;
      try {
        found = session.authorize(location, parent);
      } catch (IllegalStateException limit) {
        continue;
      }
      if (scanned != null) check(found == scanned, "indexed lookup equals the scan");
      else {
        check(!issued.contains(found), "a new location is a new capability");
        issued.add(found);
        if (random.nextInt(4) == 0) folders.add(found.id);
      }
    }
  }

  public static void main(String[] args) {
    AtomicInteger next = new AtomicInteger();
    FolderSession<String> session = new FolderSession<>(8, 5, () -> "e" + next.incrementAndGet());
    rejects(() -> new FolderSession<String>(4, 4, () -> "x"), "retain below the limit");

    FolderSession.Entry<String> root = session.root("tree:/");
    check(root.parent == null && root.id.equals(session.rootId()), "root entry");
    check(session.root("ignored") == root, "one root per session");
    FolderSession.Entry<String> docs = session.authorize("tree:/docs", root.id);
    check(session.authorize("tree:/docs", root.id) == docs, "a relisted location keeps its id");
    check(
        session.authorize("tree:/docs", "elsewhere") != docs,
        "the same location listed in another folder is another capability");
    FolderSession.Entry<String> a = session.authorize("tree:/docs/a", docs.id);
    FolderSession.Entry<String> b = session.authorize("tree:/docs/b", docs.id);
    FolderSession.Entry<String> old = session.authorize("tree:/old", root.id);
    FolderSession.Entry<String> older = session.authorize("tree:/older", root.id);
    session.touch(docs);
    check(session.size() == 7, "seven entries");

    // Listing docs at the bound evicts the least recently listed entries outside its chain.
    FolderSession.Entry<String> c = session.authorize("tree:/docs/c", docs.id);
    check(session.size() == 8, "below the bound nothing is evicted");
    FolderSession.Entry<String> d = session.authorize("tree:/docs/d", docs.id);
    check(session.get(root.id) != null && session.get(docs.id) != null, "root and folder kept");
    check(
        session.get(a.id) != null && session.get(b.id) != null && session.get(c.id) != null,
        "the folder's listed children are kept");
    check(session.get(d.id) != null, "the new child is admitted");
    check(session.get(old.id) == null && session.get(older.id) == null, "oldest outside evicted");
    check(session.size() <= 8, "bounded");

    // A folder whose own children fill the session stops listing instead of evicting them.
    FolderSession<String> full = new FolderSession<>(4, 2, () -> "f" + next.incrementAndGet());
    FolderSession.Entry<String> top = full.root("t");
    full.authorize("t/1", top.id);
    full.authorize("t/2", top.id);
    full.authorize("t/3", top.id);
    rejects(() -> full.authorize("t/4", top.id), "full of the folder's own rows");
    check(full.size() == 4, "nothing evicted");
    rejects(() -> full.authorize("t/x", "unknown-parent"), "an unknown parent cannot evict");

    // An evicted capability is gone for good: relisting its location issues a new id.
    FolderSession.Entry<String> relisted = session.authorize("tree:/old", root.id);
    check(relisted != old && !relisted.id.equals(old.id), "evicted entry is not revived");
    check(session.authorize("tree:/old", root.id) == relisted, "relisted entry is found again");

    // Rename and removal follow provider confirmation; clear forgets every capability.
    session.renamed(a, "tree:/docs/a2");
    check(a.location().equals("tree:/docs/a2"), "renamed location");
    check(session.authorize("tree:/docs/a2", docs.id) == a, "found at the renamed location");
    session.remove(b.id);
    check(session.get(b.id) == null, "removed");
    check(session.authorize("tree:/docs/b", docs.id) != b, "a removed location is new");
    session.clear();
    check(session.size() == 0 && session.rootId() == null, "cleared");
    check(session.get(null) == null, "no entry for no id");

    indexMatchesScan();

    // Revisions keep their listed format, so changes made against earlier listings still match.
    check(
        FolderSession.revision("a.txt", "text/plain", 12, 34, 5).equals("a.txt|text/plain|12|34|5"),
        "revision format");
    check(
        FolderSession.revision("Docs", "vnd.android.document/directory", -1, -1, 8)
            .equals("Docs|vnd.android.document/directory|-1|-1|8"),
        "unknown size and time");

    // Cursors name the folder they continue and the last row shown; anything else asks for a
    // refresh.
    String more = FolderSession.cursor("e3", 250, "primary:Download/a:b é.pdf");
    check(FolderSession.cursorOffset(more, "e3") == 250, "cursor offset");
    check(
        "primary:Download/a:b é.pdf".equals(FolderSession.cursorLast(more)),
        "cursor round-trips the last document id");
    check(
        FolderSession.cursorOffset(FolderSession.cursor("e4", 250, "d"), "e3")
            == FolderSession.OTHER_FOLDER,
        "other folder");
    check(
        FolderSession.cursorOffset(FolderSession.cursor("", 5, "d"), "")
            == FolderSession.OTHER_FOLDER,
        "no folder id");
    check(FolderSession.cursorOffset("e3:x:ZA", "e3") == FolderSession.MALFORMED, "malformed");
    check(FolderSession.cursorOffset("e3:0:ZA", "e3") == FolderSession.MALFORMED, "not positive");
    check(FolderSession.cursorOffset("e3:250:", "e3") == FolderSession.MALFORMED, "no last row");
    check(FolderSession.cursorOffset("e3:250:*", "e3") == FolderSession.MALFORMED, "bad last row");
    check(
        FolderSession.cursorOffset("e3:250", "e3") == FolderSession.MALFORMED
            && FolderSession.cursorLast("e3:250:") == null,
        "an older build's cursor is refused");
    check(
        FolderSession.cursorOffset(FolderSession.cursor("a:b", 7, "d"), "a:b") == 7,
        "ids may contain colons");

    // A page continues only while the row before it is unchanged: the host compares the provider
    // row at offset-1 with the cursor's last document id.
    List<String> rows = new ArrayList<>();
    for (int i = 0; i < 300; i++) rows.add("doc" + i);
    String page = FolderSession.cursor("e3", 250, rows.get(249));
    int at = FolderSession.cursorOffset(page, "e3") - 1;
    check(rows.get(at).equals(FolderSession.cursorLast(page)), "unchanged folder continues");
    List<String> removed = new ArrayList<>(rows);
    removed.remove(9);
    check(!removed.get(at).equals(FolderSession.cursorLast(page)), "a removal is a conflict");
    List<String> added = new ArrayList<>(rows);
    added.add(0, "new");
    check(!added.get(at).equals(FolderSession.cursorLast(page)), "an insertion is a conflict");

    // Child names: one path segment, no control characters.
    check(FolderSession.childName("  Reports  ").equals("Reports"), "trimmed");
    for (String bad :
        new String[] {"", " ", ".", "..", "a/b", "Q3/Q4 receipts", "a\\b", "a\nb", "x".repeat(256)})
      rejects(() -> FolderSession.childName(bad), "name " + bad.length());
    rejects(() -> FolderSession.childName(null), "null name");
    System.out.println("folder session checks: " + checks);
  }
}
