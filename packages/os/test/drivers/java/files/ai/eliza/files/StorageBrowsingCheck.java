// spec/os/android/files/storage.md, "A listing or folder walk shows dot entries only when asked, and never the Trash under any spelling"; spec/os/android/files/storage.md, "A move into another volume takes the copy path, and its copy is written and cleaned up on that volume"
package ai.eliza.files;

import ai.eliza.plugins.filesystem.browser.StorageBrowser;
import java.io.File;
import java.io.IOException;
import java.nio.file.FileStore;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.stream.Stream;

public final class StorageBrowsingCheck {
  private static final String TRASH = ".trash";
  private static int checks;

  private static void check(boolean value, String label) {
    checks++;
    if (!value) throw new AssertionError("Check " + checks + ": " + label);
  }

  private static File file(File root, String path, String text) throws IOException {
    File file = new File(root, path);
    file.getParentFile().mkdirs();
    Files.writeString(file.toPath(), text);
    return file;
  }

  private static Map<String, StorageBrowser.Row> rows(List<StorageBrowser.Row> listed) {
    Map<String, StorageBrowser.Row> out = new TreeMap<>();
    for (StorageBrowser.Row row : listed) out.put(row.path, row);
    return out;
  }

  private static String text(File root, String path) throws IOException {
    return Files.readString(new File(root, path).toPath());
  }

  private static void remove(Path root) throws IOException {
    if (!Files.exists(root)) return;
    try (Stream<Path> walk = Files.walk(root)) {
      for (Path path : walk.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
    }
  }

  private static void listing(File a) throws IOException {
    file(a, "Docs/notes", "alpha");
    file(a, "Docs/.draft", "x");
    file(a, ".config/settings", "k=v");
    file(a, ".nomedia", "");
    file(a, ".trash/files/old", "gone");
    file(a, "Docs/.trash/kept", "nested");
    new File(a, "Docs/.hidden-dir/deep").mkdirs();
    StorageBrowser browser = new StorageBrowser(a, TRASH);

    Map<String, StorageBrowser.Row> plain = rows(browser.list(""));
    check(plain.keySet().equals(Set.of("Docs")), "the default listing hides dot entries and the Trash: " + plain.keySet());
    check(plain.get("Docs").children == 1, "the default child count skips dot entries");
    Map<String, StorageBrowser.Row> all = rows(browser.list("", true));
    check(all.keySet().equals(Set.of("Docs", ".config", ".nomedia")), "hidden entries are listed when asked, never the Trash: " + all.keySet());
    check(all.get("Docs").children == 4, "the hidden child count includes dot entries");
    check(rows(browser.list("Docs", true)).containsKey("Docs/.trash"), "a nested folder named like the Trash is an ordinary hidden folder");
    check(rows(browser.list(".config", false)).containsKey(".config/settings"), "a hidden folder opened by path lists its children");

    Set<String> walked = rows(browser.folders("", null, 0, 0, 100, 100)).keySet();
    check(walked.equals(Set.of("Docs")), "the default walk skips hidden folders: " + walked);
    walked = rows(browser.folders("", null, 0, 0, 100, 100, true)).keySet();
    check(walked.equals(Set.of("Docs", ".config", "Docs/.trash", "Docs/.hidden-dir", "Docs/.hidden-dir/deep")), "the hidden walk enters dot folders, never the Trash: " + walked);
  }

  private static void anyCase(File c) throws IOException {
    file(c, ".TRASH/files/old", "gone");
    file(c, ".seen", "x");
    StorageBrowser browser = new StorageBrowser(c, TRASH);
    Set<String> listed = rows(browser.list("", true)).keySet();
    check(listed.equals(Set.of(".seen")), "the Trash is never listed whatever its case: " + listed);
    check(rows(browser.folders("", null, 0, 0, 100, 100, true)).isEmpty(), "the Trash is never walked whatever its case");
  }

  private static void anotherVolume(File a, File b) throws IOException {
    StorageBrowser source = new StorageBrowser(a, TRASH), target = new StorageBrowser(b, TRASH);
    new File(b, "In").mkdirs();
    file(b, "In/notes", "clash");
    List<StorageBrowser.Outcome> copied = source.transfer(List.of("Docs/notes", "Docs"), target, "In", true, null);
    check(copied.get(0).status.equals("copied") && copied.get(0).to.equals("In/notes (1)"), "a copy to another volume keeps both on a clash and names the path there: " + copied.get(0).to);
    check(copied.get(1).status.equals("copied") && copied.get(1).to.equals("In/Docs"), "a folder copies to the other volume");
    check(text(b, "In/Docs/.trash/kept").equals("nested") && text(a, "Docs/notes").equals("alpha"), "a folder copy includes hidden children and keeps its source");

    List<StorageBrowser.Outcome> moved = source.transfer(List.of(".config"), target, "", false, null);
    check(moved.get(0).status.equals("moved") && moved.get(0).to.equals(".config"), "a move to another volume names the path there");
    check(!new File(a, ".config").exists() && text(b, ".config/settings").equals("k=v"), "a move removes the source only after the copy");

    boolean refused = false;
    try {
      source.transfer(List.of("Docs/notes"), target, TRASH, true, null);
    } catch (IllegalArgumentException expected) {
      refused = true;
    }
    check(refused, "the other volume's Trash is never a destination");

    file(a, "Tree/ok", "ok");
    Files.createSymbolicLink(new File(a, "Tree/link").toPath(), new File(a, "Docs/notes").toPath());
    List<StorageBrowser.Outcome> partial = source.transfer(List.of("Tree"), target, "", true, null);
    check(partial.get(0).status.equals("failed") && !new File(b, "Tree").exists(), "a copy that fails part way is removed from the volume it was written to");
    check(new File(a, "Tree/ok").isFile(), "a failed copy keeps its source");
  }

  private static void anotherMount(File a, Path mount) throws IOException {
    Path other = Files.createTempDirectory(mount, "storage-browsing-");
    try {
      File b = other.toFile();
      StorageBrowser source = new StorageBrowser(a, TRASH), target = new StorageBrowser(b, TRASH);
      file(a, "Mounted/report", "mounted");
      List<StorageBrowser.Outcome> moved = source.transfer(List.of("Mounted"), target, "", false, null);
      check(moved.get(0).status.equals("moved") && moved.get(0).to.equals("Mounted"), "a move across mounts is acknowledged with the path there");
      check(!new File(a, "Mounted").exists() && text(b, "Mounted/report").equals("mounted"), "a move across mounts copies, then removes the source");
      file(a, "Linked/ok", "ok");
      Files.createSymbolicLink(new File(a, "Linked/link").toPath(), new File(a, "Docs/notes").toPath());
      List<StorageBrowser.Outcome> partial = source.transfer(List.of("Linked"), target, "", false, null);
      check(partial.get(0).status.equals("failed") && !new File(b, "Linked").exists() && new File(a, "Linked/ok").isFile(), "a failed move across mounts leaves the source whole and no remnant there");
    } finally {
      remove(other);
    }
  }

  public static void main(String[] args) throws IOException {
    Path work = Files.createTempDirectory("storage-browsing-");
    try {
      File a = Files.createDirectory(work.resolve("volume-a")).toFile();
      File b = Files.createDirectory(work.resolve("volume-b")).toFile();
      File c = Files.createDirectory(work.resolve("volume-c")).toFile();
      listing(a);
      anyCase(c);
      anotherVolume(a, b);
      Path shm = Path.of("/dev/shm");
      FileStore here = Files.getFileStore(work);
      if (Files.isDirectory(shm) && Files.isWritable(shm) && !Files.getFileStore(shm).equals(here)) anotherMount(a, shm);
    } finally {
      remove(work);
    }
    System.out.println("StorageBrowsingCheck checks: " + checks);
  }
}
