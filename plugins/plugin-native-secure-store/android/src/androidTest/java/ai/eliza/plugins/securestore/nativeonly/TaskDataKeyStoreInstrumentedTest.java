package ai.eliza.plugins.securestore.nativeonly;

import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyStore;
import java.util.*;
import java.util.concurrent.*;
import org.junit.Test;
import static org.junit.Assert.*;

/** Synthetic accounts only; tests real Android Keystore custody, never a database encryption claim. */
public final class TaskDataKeyStoreInstrumentedTest {
  private static final class Fixture implements AutoCloseable {
    final File root = new File(InstrumentationRegistry.getInstrumentation().getTargetContext()
        .getNoBackupFilesDir(), "task-key-" + UUID.randomUUID());
    final String alias = "eliza.task-key-test." + UUID.randomUUID();
    final String prefix = alias + ".slot.";
    final KeyStore keys = KeyStore.getInstance("AndroidKeyStore");
    Fixture() throws Exception { assertTrue(root.mkdirs()); keys.load(null); }
    TaskDataKeyStore store() { return new TaskDataKeyStore(root, alias); }
    TaskDataKeyStore perSlot() { return TaskDataKeyStore.perSlot(root, prefix, true); }
    List<String> slotAliases() throws Exception {
      List<String> result = new ArrayList<>();
      for (String name : Collections.list(keys.aliases())) if (name.startsWith(prefix)) result.add(name);
      return result;
    }
    File file(String account, String database) throws Exception {
      JsonCredentialSlots slots = new JsonCredentialSlots(root, alias, slot -> 512);
      return slots.slotFile(slots.slotHash(TaskDataKeyStore.slot(account, database))).getBaseFile();
    }
    @Override public void close() throws Exception {
      for (File file : root.listFiles()) assertTrue(file.delete());
      assertTrue(root.delete()); keys.deleteEntry(alias);
      for (String name : slotAliases()) keys.deleteEntry(name);
    }
  }

  @Test public void durableKeysAreIsolatedAndGenerationDeletionCannotEraseReplacement() throws Exception {
    try (Fixture f = new Fixture()) {
      assertNull(f.store().read("owner", "tasks"));
      assertFalse(f.keys.containsAlias(f.alias));
      String generation;
      byte[] original;
      try (TaskDataKeyStore.Key key = f.store().createIfAbsent("owner", "tasks")) {
        generation = key.id; original = key.copyBytes(); assertEquals(32, original.length);
        try (TaskDataKeyStore.Key reopened = f.store().read("owner", "tasks")) {
          assertEquals(generation, reopened.id); assertArrayEquals(original, reopened.copyBytes());
        }
        byte[] ciphertext = Files.readAllBytes(f.file("owner", "tasks").toPath());
        assertFalse(new String(ciphertext, StandardCharsets.ISO_8859_1)
            .contains(Base64.getEncoder().encodeToString(original)));
        assertNull(f.keys.getKey(f.alias, null).getEncoded());
      }
      assertNull(f.store().read("other-owner", "tasks"));
      assertNull(f.store().read("owner", "other-database"));
      try (TaskDataKeyStore.Key other = f.store().createIfAbsent("other-owner", "tasks")) {
        assertFalse(Arrays.equals(original, other.copyBytes()));
      }
      assertTrue(f.store().remove("owner", "tasks", generation));
      assertNull(f.store().read("owner", "tasks"));
      try (TaskDataKeyStore.Key replacement = f.store().createIfAbsent("owner", "tasks")) {
        assertNotEquals(generation, replacement.id);
        assertFalse(f.store().remove("owner", "tasks", generation));
        try (TaskDataKeyStore.Key preserved = f.store().read("owner", "tasks")) {
          assertEquals(replacement.id, preserved.id);
        }
        replacement.close();
        try { replacement.copyBytes(); fail("Closed key exposed"); }
        catch (IllegalStateException expected) {}
      }
      Arrays.fill(original, (byte) 0);
    }
  }

  @Test public void concurrentCreationReturnsOneDurableGenerationAndBackupRecovers() throws Exception {
    try (Fixture f = new Fixture()) {
      ExecutorService pool = Executors.newFixedThreadPool(6);
      try {
        CountDownLatch start = new CountDownLatch(1);
        List<Future<String>> results = new ArrayList<>();
        for (int i = 0; i < 6; i++) results.add(pool.submit(() -> {
          start.await();
          try (TaskDataKeyStore.Key key = f.store().createIfAbsent("owner", "tasks")) { return key.id; }
        }));
        start.countDown(); Set<String> generations = new HashSet<>();
        for (Future<String> result : results) generations.add(result.get(30, TimeUnit.SECONDS));
        assertEquals(1, generations.size());
        File file = f.file("owner", "tasks");
        Files.move(file.toPath(), new File(file + ".bak").toPath());
        try (TaskDataKeyStore.Key recovered = f.store().read("owner", "tasks")) {
          assertTrue(generations.contains(recovered.id));
        }
      } finally { pool.shutdownNow(); assertTrue(pool.awaitTermination(30, TimeUnit.SECONDS)); }
    }
  }

  @Test public void corruptCopiedAndLostWrappingKeysAreNeverReplaced() throws Exception {
    try (Fixture f = new Fixture()) {
      try (TaskDataKeyStore.Key key = f.store().createIfAbsent("owner", "tasks")) { assertNotNull(key); }
      File source = f.file("owner", "tasks"); byte[] committed = Files.readAllBytes(source.toPath());
      File copied = f.file("other", "tasks"); Files.write(copied.toPath(), committed);
      try { f.store().createIfAbsent("other", "tasks"); fail("Copied key accepted"); }
      catch (javax.crypto.AEADBadTagException expected) {}
      assertArrayEquals(committed, Files.readAllBytes(copied.toPath()));
      byte[] corrupt = committed.clone(); corrupt[corrupt.length - 1] ^= 1; Files.write(source.toPath(), corrupt);
      try { f.store().createIfAbsent("owner", "tasks"); fail("Corrupt key replaced"); }
      catch (javax.crypto.AEADBadTagException expected) {}
      assertArrayEquals(corrupt, Files.readAllBytes(source.toPath()));
      Files.write(source.toPath(), committed); f.keys.deleteEntry(f.alias);
      try { f.store().createIfAbsent("owner", "tasks"); fail("Lost wrapping key replaced data key"); }
      catch (javax.crypto.AEADBadTagException expected) {}
      assertArrayEquals(committed, Files.readAllBytes(source.toPath()));
    }
  }

  @Test public void malformedAuthenticatedRecordsAreNotTreatedAsEmptyCustody() throws Exception {
    try (Fixture f = new Fixture()) {
      JsonCredentialSlots slots = new JsonCredentialSlots(f.root, f.alias, slot -> 512);
      String slot = TaskDataKeyStore.slot("owner", "tasks");
      String id = UUID.randomUUID().toString();
      for (String bad : new String[] {"{}", "null",
          "{\"version\":1,\"id\":\"" + id + "\",\"key\":\"AA==\"}",
          "{\"version\":2,\"id\":\"" + id + "\",\"key\":\"" + Base64.getEncoder().encodeToString(new byte[32]) + "\"}"}) {
        slots.write(slot, bad);
        byte[] committed = Files.readAllBytes(f.file("owner", "tasks").toPath());
        try { f.store().createIfAbsent("owner", "tasks"); fail("Malformed custody replaced"); }
        catch (org.json.JSONException | IllegalArgumentException | IllegalStateException expected) {}
        assertArrayEquals(committed, Files.readAllBytes(f.file("owner", "tasks").toPath()));
      }
    }
  }

  @Test public void perSlotKeysAreCryptoErasedAndNeverRecreatedByReads() throws Exception {
    try (Fixture f = new Fixture()) {
      assertNull(f.perSlot().read("owner", "tasks"));
      assertTrue(f.slotAliases().isEmpty());
      String generation;
      try (TaskDataKeyStore.Key key = f.perSlot().createIfAbsent("owner", "tasks");
           TaskDataKeyStore.Key other = f.perSlot().createIfAbsent("other-owner", "tasks")) {
        generation = key.id;
        assertEquals(2, f.slotAliases().size());
        assertFalse(f.keys.containsAlias(f.alias));
        assertNull(f.keys.getKey(f.slotAliases().get(0), null).getEncoded());
        try (TaskDataKeyStore.Key reopened = f.perSlot().read("owner", "tasks")) {
          assertEquals(generation, reopened.id); assertArrayEquals(key.copyBytes(), reopened.copyBytes());
        }
        assertTrue(f.perSlot().destroy("owner", "tasks"));
        assertFalse(f.file("owner", "tasks").exists());
        assertNull(f.perSlot().read("owner", "tasks"));
        assertEquals(1, f.slotAliases().size());
        try (TaskDataKeyStore.Key kept = f.perSlot().read("other-owner", "tasks")) { assertEquals(other.id, kept.id); }
        assertTrue(f.perSlot().remove("other-owner", "tasks", other.id));
      }
      assertTrue(f.slotAliases().isEmpty());
      assertFalse(f.perSlot().destroy("owner", "tasks"));

      // An interrupted destroy leaves the wrapped copy without its Keystore entry.
      try (TaskDataKeyStore.Key key = f.perSlot().createIfAbsent("owner", "tasks")) { assertNotEquals(generation, key.id); }
      File wrapped = f.file("owner", "tasks"); byte[] committed = Files.readAllBytes(wrapped.toPath());
      f.keys.deleteEntry(f.slotAliases().get(0));
      for (int i = 0; i < 2; i++) {
        try { f.perSlot().createIfAbsent("owner", "tasks"); fail("Erased custody replaced"); }
        catch (TaskDataKeyStore.WrappingKeyMissingException expected) {}
      }
      assertTrue(f.slotAliases().isEmpty());
      assertArrayEquals(committed, Files.readAllBytes(wrapped.toPath()));
      assertTrue(f.perSlot().destroy("owner", "tasks"));
      assertFalse(wrapped.exists());
      assertNull(f.perSlot().read("owner", "tasks"));
      try { f.store().destroy("owner", "tasks"); fail("Shared alias destroyed"); }
      catch (IllegalStateException expected) {}
    }
  }

  @Test public void adoptionMovesOneGenerationAndResumesAfterAStop() throws Exception {
    try (Fixture f = new Fixture()) {
      assertFalse(f.perSlot().adopt("pending", "owner", "tasks", null));
      String generation; byte[] original;
      try (TaskDataKeyStore.Key key = f.perSlot().createIfAbsent("pending", "tasks")) {
        generation = key.id; original = key.copyBytes();
      }
      try {
        f.perSlot().adopt("pending", "owner", "tasks", () -> { throw new java.io.IOException("Simulated stop"); });
        fail("Stop ignored");
      } catch (java.io.IOException expected) {}
      for (String account : new String[] {"pending", "owner"}) {
        try (TaskDataKeyStore.Key held = f.perSlot().read(account, "tasks")) { assertEquals(generation, held.id); }
      }
      int[] steps = {0};
      assertTrue(f.perSlot().adopt("pending", "owner", "tasks", () -> steps[0]++));
      assertEquals(1, steps[0]);
      assertNull(f.perSlot().read("pending", "tasks"));
      try (TaskDataKeyStore.Key moved = f.perSlot().read("owner", "tasks")) {
        assertEquals(generation, moved.id); assertArrayEquals(original, moved.copyBytes());
      }
      assertEquals(1, f.slotAliases().size());

      // An account with its own key history keeps it, and the source is left unchanged.
      try (TaskDataKeyStore.Key pending = f.perSlot().createIfAbsent("pending", "tasks")) {
        assertFalse(f.perSlot().adopt("pending", "owner", "tasks", () -> fail("Step ran")));
        try (TaskDataKeyStore.Key kept = f.perSlot().read("pending", "tasks")) { assertEquals(pending.id, kept.id); }
        try (TaskDataKeyStore.Key kept = f.perSlot().read("owner", "tasks")) { assertEquals(generation, kept.id); }
      }
      Arrays.fill(original, (byte) 0);
    }
  }

  @Test public void identitiesAreExactLengthBoundAndMalformedUnicodeFails() throws Exception {
    assertNotEquals(TaskDataKeyStore.slot("a", "bc"), TaskDataKeyStore.slot("ab", "c"));
    assertNotEquals(TaskDataKeyStore.slot("owner", "tasks"), TaskDataKeyStore.slot("owner ", "tasks"));
    assertNotEquals(TaskDataKeyStore.slot("é", "tasks"), TaskDataKeyStore.slot("e\u0301", "tasks"));
    for (String bad : new String[] {null, "", "\uD800"}) {
      try { TaskDataKeyStore.slot(bad, "tasks"); fail("Invalid owner accepted"); }
      catch (IllegalArgumentException | java.nio.charset.CharacterCodingException expected) {}
    }
  }
}
