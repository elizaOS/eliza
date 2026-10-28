package ai.eliza.plugins.media;

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

    // Rename and removal follow provider confirmation; clear forgets every capability.
    session.renamed(a, "tree:/docs/a2");
    check(a.location().equals("tree:/docs/a2"), "renamed location");
    session.remove(b.id);
    check(session.get(b.id) == null, "removed");
    session.clear();
    check(session.size() == 0 && session.rootId() == null, "cleared");
    check(session.get(null) == null, "no entry for no id");

    // Cursors name the folder they continue; anything else asks for a refresh.
    check(FolderSession.cursorOffset(FolderSession.cursor("e3", 250), "e3") == 250, "cursor");
    check(FolderSession.cursorOffset("e4:250", "e3") == FolderSession.OTHER_FOLDER, "other folder");
    check(FolderSession.cursorOffset(":5", "") == FolderSession.OTHER_FOLDER, "no folder id");
    check(FolderSession.cursorOffset("e3:x", "e3") == FolderSession.MALFORMED, "malformed");
    check(FolderSession.cursorOffset("e3:0", "e3") == FolderSession.MALFORMED, "not positive");
    check(FolderSession.cursorOffset("a:b:7", "a:b") == 7, "ids may contain colons");

    // Child names: one path segment, no control characters.
    check(FolderSession.childName("  Reports  ").equals("Reports"), "trimmed");
    for (String bad : new String[] {"", " ", ".", "..", "a/b", "a\\b", "a\nb", "x".repeat(256)})
      rejects(() -> FolderSession.childName(bad), "name " + bad.length());
    rejects(() -> FolderSession.childName(null), "null name");
    System.out.println("folder session checks: " + checks);
  }
}
