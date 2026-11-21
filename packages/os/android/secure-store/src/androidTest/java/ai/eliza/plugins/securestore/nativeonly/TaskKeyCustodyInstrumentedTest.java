package ai.eliza.plugins.securestore.nativeonly;

import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import org.junit.Test;
import static org.junit.Assert.*;

// spec/os/android/taskKeys.md, "Each account has at most one task key, and a stored key is never replaced"; spec/os/android/taskKeys.md, "The current account's key is released only as the storage key of a launch newer than every earlier one"; spec/os/android/taskKeys.md, "An account change, a sign-out or a reset retires the release"
public final class TaskKeyCustodyInstrumentedTest {
  private static final String AUTHORITY = "https://cloud.example";
  private static final TaskKeyCustody.Account FIRST = new TaskKeyCustody.Account("user-1", "org-1");
  private static final TaskKeyCustody.Account SECOND = new TaskKeyCustody.Account("user-2", "org-2");

  private static final class Fixture implements AutoCloseable {
    final File root = new File(InstrumentationRegistry.getInstrumentation().getTargetContext()
        .getNoBackupFilesDir(), "task-key-custody-" + UUID.randomUUID());
    final String prefix = "eliza.task-key-custody-test." + UUID.randomUUID() + ".";
    final KeyStore keystore = KeyStore.getInstance("AndroidKeyStore");
    final TaskDataKeyStore keys = TaskDataKeyStore.perSlot(root, prefix, false);
    final TaskKeyCustody custody = new TaskKeyCustody(root, keys, AUTHORITY);

    Fixture() throws Exception { assertTrue(root.mkdirs()); keystore.load(null); }

    String alias(TaskKeyCustody.Account account) throws Exception {
      return keys.wrappingKeyAlias(custody.ownerIdentity(account), TaskKeyCustody.STORE);
    }

    File wrapped(TaskKeyCustody.Account account) throws Exception {
      return keys.wrappedFile(custody.ownerIdentity(account), TaskKeyCustody.STORE);
    }

    @Override public void close() throws Exception {
      List<String> aliases = new ArrayList<>();
      for (String name : Collections.list(keystore.aliases())) if (name.startsWith(prefix)) aliases.add(name);
      for (String name : aliases) keystore.deleteEntry(name);
      File[] files = root.listFiles();
      if (files != null) for (File file : files) assertTrue(file.delete());
      assertTrue(root.delete());
    }
  }

  private static TaskKeyCustody.Refusal refusal(TaskKeyCustody custody, TaskKeyCustody.Account account, long epoch) {
    try (TaskKeyCustody.StorageKey unexpected = custody.releaseForLaunch(account, epoch)) {
      fail("Expected a refused release");
      return null;
    } catch (TaskKeyCustody.ReleaseRefused refused) {
      return refused.refusal;
    }
  }

  @Test public void eachAccountGetsItsOwnKeyOnlyForANewerLaunch() throws Exception {
    try (Fixture f = new Fixture()) {
      assertEquals(TaskKeyCustody.Refusal.NotVerifiedAccount, refusal(f.custody, FIRST, 1));
      f.custody.accountVerified(FIRST);
      TaskKeyCustody.StorageKey first = f.custody.releaseForLaunch(FIRST, 1);
      String value = first.value();
      assertEquals(32, Base64.getDecoder().decode(value).length);
      assertFalse(first.toString().contains(value));
      assertFalse(new String(Files.readAllBytes(f.wrapped(FIRST).toPath()), StandardCharsets.ISO_8859_1).contains(value));
      assertEquals(TaskKeyCustody.Refusal.StaleEpoch, refusal(f.custody, FIRST, 1));
      assertEquals(TaskKeyCustody.Refusal.NotVerifiedAccount, refusal(f.custody, SECOND, 2));

      TaskKeyCustody.StorageKey relaunch = f.custody.releaseForLaunch(FIRST, 2);
      assertEquals(value, relaunch.value());
      assertTrue(first.retired());

      f.custody.accountVerified(SECOND);
      assertTrue(relaunch.retired());
      assertEquals(TaskKeyCustody.Refusal.StaleEpoch, refusal(f.custody, SECOND, 2));
      try (TaskKeyCustody.StorageKey second = f.custody.releaseForLaunch(SECOND, 3)) {
        assertNotEquals(value, second.value());
      }

      f.custody.accountVerified(FIRST);
      try (TaskKeyCustody.StorageKey again = f.custody.releaseForLaunch(FIRST, 4)) {
        assertEquals(value, again.value());
      }

      TaskKeyCustody reopened = new TaskKeyCustody(f.root, f.keys, AUTHORITY);
      reopened.accountVerified(FIRST);
      assertEquals(TaskKeyCustody.Refusal.StaleEpoch, refusal(reopened, FIRST, 4));
      try (TaskKeyCustody.StorageKey afterRestart = reopened.releaseForLaunch(FIRST, 5)) {
        assertEquals(value, afterRestart.value());
      }
    }
  }

  @Test public void signOutAndResetRetireTheRelease() throws Exception {
    try (Fixture f = new Fixture()) {
      f.custody.accountVerified(FIRST);
      TaskKeyCustody.StorageKey held = f.custody.releaseForLaunch(FIRST, 1);
      f.custody.accountVerified(FIRST);
      assertFalse(held.retired());
      f.custody.signedOut();
      assertTrue(held.retired());
      try { held.value(); fail("Retired key exposed"); } catch (IllegalStateException expected) {}
      assertEquals(TaskKeyCustody.Refusal.NotVerifiedAccount, refusal(f.custody, FIRST, 2));

      f.custody.accountVerified(FIRST);
      TaskKeyCustody.StorageKey next = f.custody.releaseForLaunch(FIRST, 2);
      String before = next.value();
      f.custody.reset();
      assertTrue(next.retired());
      assertEquals(TaskKeyCustody.Refusal.NotVerifiedAccount, refusal(f.custody, FIRST, 3));
      assertFalse(f.keystore.containsAlias(f.alias(FIRST)));
      assertFalse(f.wrapped(FIRST).exists());

      TaskKeyCustody reopened = new TaskKeyCustody(f.root, f.keys, AUTHORITY);
      reopened.accountVerified(FIRST);
      try (TaskKeyCustody.StorageKey fresh = reopened.releaseForLaunch(FIRST, 1)) {
        assertNotEquals(before, fresh.value());
      }
    }
  }

  @Test public void anUnreadableKeyIsRefusedAndNeverReplaced() throws Exception {
    try (Fixture f = new Fixture()) {
      f.custody.accountVerified(FIRST);
      f.custody.releaseForLaunch(FIRST, 1).close();
      f.keystore.deleteEntry(f.alias(FIRST));
      assertEquals(TaskKeyCustody.Refusal.KeyUnavailable, refusal(f.custody, FIRST, 2));
      assertFalse(f.keystore.containsAlias(f.alias(FIRST)));
      assertTrue(f.wrapped(FIRST).exists());
      assertEquals(TaskKeyCustody.Refusal.StaleEpoch, refusal(f.custody, FIRST, 2));

      f.custody.accountVerified(SECOND);
      f.custody.releaseForLaunch(SECOND, 3).close();
      assertTrue(f.wrapped(SECOND).delete());
      f.keystore.deleteEntry(f.alias(SECOND));
      assertEquals(TaskKeyCustody.Refusal.KeyUnavailable, refusal(f.custody, SECOND, 4));
      assertFalse(f.keystore.containsAlias(f.alias(SECOND)));

      TaskKeyCustody restarted = new TaskKeyCustody(f.root, f.keys, AUTHORITY);
      restarted.accountVerified(SECOND);
      assertEquals(TaskKeyCustody.Refusal.StaleEpoch, refusal(restarted, SECOND, 4));
      assertEquals(TaskKeyCustody.Refusal.KeyUnavailable, refusal(restarted, SECOND, 5));
      assertFalse(f.keystore.containsAlias(f.alias(SECOND)));
      assertFalse(f.wrapped(SECOND).exists());

      restarted.reset();
      restarted.accountVerified(SECOND);
      try (TaskKeyCustody.StorageKey fresh = restarted.releaseForLaunch(SECOND, 1)) {
        assertEquals(32, Base64.getDecoder().decode(fresh.value()).length);
      }
    }
  }
}
