package ai.eliza.plugins.securestore.nativeonly;

import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyStore;
import java.util.Arrays;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

/** Multi-binding entries on the real Keystore with synthetic values and an unauthenticated
 * test-only key. Authentication-bound policies are covered by the policy assertions below. */
public final class PasswordVaultEntriesInstrumentedTest {
  private static final String APP = "android://abababababababababababababababababababababababababababababababab@com.example.synthetic";

  @Test public void entriesKeepBindingsAndNeverExposePasswords() throws Exception {
    File root = new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getNoBackupFilesDir(), "password-entries-" + UUID.randomUUID());
    String alias = "eliza.password-entries-test." + UUID.randomUUID();
    byte[] aad = "fixture-host/passwords/v1".getBytes(StandardCharsets.UTF_8);
    KeyStore keys = KeyStore.getInstance("AndroidKeyStore"); keys.load(null);
    try {
      PasswordVaultStore vault = new PasswordVaultStore(root, alias, aad, (PasswordVaultStore.KeyPolicy) null);
      String secret = "synthetic-entry-value-7Q";
      String id = vault.saveEntry(null, "Example", "fixture-user", Arrays.asList("https://Example.test/", APP, "https://example.test"), secret);
      JSONArray entries = vault.entries();
      assertEquals(1, entries.length());
      JSONObject entry = entries.getJSONObject(0);
      assertFalse(entry.has("password"));
      assertFalse(entries.toString().contains(secret));
      assertEquals("Example", entry.getString("label"));
      assertEquals(Arrays.asList("https://example.test", APP), PasswordVaultStore.bindings(entry));
      assertFalse(new String(Files.readAllBytes(new File(root, "vault.enc").toPath()), StandardCharsets.ISO_8859_1).contains(secret));
      // Legacy readers keep working: list() still reports the primary web origin.
      assertEquals("https://example.test", vault.list().getJSONObject(0).getString("origin"));
      // A null password keeps the stored value on update.
      vault.saveEntry(id, "Renamed", "fixture-user", Arrays.asList(APP), null);
      assertEquals(secret, vault.get(id).getString("password"));
      assertEquals("", vault.list().getJSONObject(0).getString("origin"));
      try { vault.saveEntry(null, "No password", "u", Arrays.asList("https://example.test"), null); fail("Created without a password"); } catch (java.io.IOException expected) {}
      try { vault.saveEntry(null, "Bad", "u", Arrays.asList("http://example.test"), "x"); fail("Accepted HTTP"); } catch (java.io.IOException expected) {}
      try { vault.saveEntry(null, " ", "u", Arrays.asList("https://example.test"), "x"); fail("Accepted empty name"); } catch (java.io.IOException expected) {}
      // Legacy single-origin records appear with one derived binding.
      String legacy = vault.save(null, "https://legacy.example.test", "legacy-user", "synthetic-legacy");
      for (int i = 0; i < vault.entries().length(); i++) {
        JSONObject item = vault.entries().getJSONObject(i);
        if (item.getString("id").equals(legacy)) assertEquals(Arrays.asList("https://legacy.example.test"), PasswordVaultStore.bindings(item));
      }
      // A readable vault is never reset.
      assertFalse(vault.unrecoverable());
      try { vault.resetUnrecoverable(); fail("Reset a readable vault"); } catch (java.io.IOException expected) { assertEquals("Saved passwords are not damaged", expected.getMessage()); }
      assertTrue(vault.entries().length() > 0);
      vault.delete(id); vault.delete(legacy);
      assertEquals(0, vault.entries().length());
      // Re-opening an alias under a different policy is refused rather than silently re-keyed.
      try { new PasswordVaultStore(root, alias, aad, new PasswordVaultStore.KeyPolicy(60, true)).entries(); fail("Policy mismatch accepted"); }
      catch (java.io.IOException expected) {}
      // A lost key leaves undecryptable records: reported as KeyLost, then deletable.
      vault.saveEntry(null, "Lost", "fixture-user", Arrays.asList("https://example.test"), secret);
      keys.deleteEntry(alias);
      try { vault.entries(); fail("Read without a key"); } catch (PasswordVaultStore.KeyLost expected) {}
      assertTrue(vault.unrecoverable());
      vault.resetUnrecoverable();
      assertFalse(new File(root, "vault.enc").exists());
      assertFalse(vault.unrecoverable());
      assertEquals(0, vault.entries().length());
      vault.saveEntry(null, "Fresh", "fixture-user", Arrays.asList("https://example.test"), secret);
      assertEquals(1, vault.entries().length());
    } finally {
      File[] files = root.listFiles(); if (files != null) for (File file : files) file.delete(); root.delete();
      if (keys.containsAlias(alias)) keys.deleteEntry(alias);
    }
  }
}
