package ai.eliza.plugins.agent.updater;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.file.*;

public final class PreparedAuthorizationStoreTest {
  static int assertions;
  static void check(boolean value) { assertions++; if (!value) throw new AssertionError(); }
  public static void main(String[] args) throws Exception {
    Path root = Path.of(args[0]); Files.createDirectories(root);
    UpdateJournal journal = new UpdateJournal(root.resolve("journal"), directory -> {
      try (FileChannel file = FileChannel.open(directory, StandardOpenOption.READ)) { file.force(true); }
    });
    UpdateJournal.Identity baseline = new UpdateJournal.Identity(1, "a".repeat(64));
    UpdateJournal.Plan plan = new UpdateJournal.Plan("release-2", "stable", "standalone", baseline,
      new UpdateJournal.Identity(2, "b".repeat(64)), new UpdateJournal.Identity(3, "c".repeat(64)));
    boolean[] authorize = {false}; String[] retained = {null}; int[] calls = {0};
    PreparedAuthorizationStore store = new PreparedAuthorizationStore(journal, root.resolve("prepared").toFile(), new PreparedAuthorizationStore.Authority() {
      public void prune(String directory, String id) { check(directory.equals(root.resolve("prepared").toAbsolutePath().toString())); retained[0] = id; }
      public void verify(String directory, UpdateJournal.Plan supplied, long generation, byte[] candidate, byte[] recovery) throws Exception {
        calls[0]++; check(supplied.id.equals(plan.id)); check(generation == 0); check(candidate[0] == 4 && recovery[0] == 5);
        if (!authorize[0]) throw new IOException("expired authority");
      }
    });
    store.prune(); check(retained[0].isEmpty());
    try { store.begin(plan, baseline, 0, new byte[]{4}, new byte[]{5}); throw new AssertionError(); }
    catch (IOException expected) { check(expected.getCause().getMessage().equals("expired authority")); }
    check(journal.read().phase == UpdateJournal.Phase.IDLE);
    authorize[0] = true;
    check(store.begin(plan, baseline, 0, new byte[]{4}, new byte[]{5}).phase == UpdateJournal.Phase.VERIFIED);
    store.prune(); check(retained[0].equals(plan.id)); check(calls[0] == 2);
    System.out.println("PreparedAuthorizationStore: " + assertions + " assertions passed");
  }
}
