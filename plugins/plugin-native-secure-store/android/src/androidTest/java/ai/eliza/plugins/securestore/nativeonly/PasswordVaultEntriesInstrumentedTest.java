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
      JSONArray exported = vault.exportEntries();
      assertEquals(2, exported.length());
      assertEquals("Renamed", exported.getJSONObject(0).getString("label"));
      assertEquals(secret, exported.getJSONObject(0).getString("password"));
      assertEquals("https://legacy.example.test", exported.getJSONObject(1).getString("label"));
      assertEquals("synthetic-legacy", exported.getJSONObject(1).getString("password"));
      // A readable vault is never reset.
      assertFalse(vault.unrecoverable());
      try { vault.resetUnrecoverable(); fail("Reset a readable vault"); } catch (java.io.IOException expected) { assertEquals("Saved passwords are not damaged", expected.getMessage()); }
      assertTrue(vault.entries().length() > 0);
      vault.delete(id); vault.delete(legacy);
      assertEquals(0, vault.entries().length());
      // A reviewed import is one transaction against the current vault. A row
      // added since review is skipped; neither it nor repeated rows are overwritten.
      String retained = vault.saveEntry(null, "Retained", "same-user", Arrays.asList("https://example.test"), secret);
      JSONArray incoming = new JSONArray()
        .put(new JSONObject().put("label", "Replace").put("origin", "https://EXAMPLE.test:443/").put("username", "same-user").put("password", "must-not-replace"))
        .put(new JSONObject().put("label", "New").put("origin", "https://new.test").put("username", "new-user").put("password", "synthetic-import"))
        .put(new JSONObject().put("label", "Duplicate").put("origin", "https://new.test").put("username", "new-user").put("password", "must-not-replace"));
      assertEquals(1, vault.addWebsiteEntries(incoming));
      assertEquals(secret, vault.get(retained).getString("password"));
      byte[] committed = Files.readAllBytes(new File(root, "vault.enc").toPath());
      // A late invalid row must not leave the earlier valid row partially saved.
      JSONArray invalidBatch = new JSONArray()
        .put(new JSONObject().put("label", "Valid first").put("origin", "https://first.test").put("username", "u").put("password", "synthetic"))
        .put(new JSONObject().put("label", "Invalid last").put("origin", "http://last.test").put("username", "u").put("password", "synthetic"));
      try { vault.addWebsiteEntries(invalidBatch); fail("Accepted invalid batch"); } catch (java.io.IOException expected) {}
      assertArrayEquals(committed, Files.readAllBytes(new File(root, "vault.enc").toPath()));
      PasswordVaultStore reopened = new PasswordVaultStore(root, alias, aad, (PasswordVaultStore.KeyPolicy) null);
      assertEquals(2, reopened.entries().length());
      JSONArray oversized = new JSONArray();
      for (int i = 0; i < PasswordVaultStore.MAX_ENTRIES; i++) oversized.put(new JSONObject()
        .put("label", "Synthetic").put("origin", "https://capacity.test").put("username", "u" + i).put("password", "synthetic"));
      try { reopened.addWebsiteEntries(oversized); fail("Partially imported an oversized batch"); }
      catch (java.io.IOException expected) { assertEquals("Password vault is full", expected.getMessage()); }
      assertArrayEquals(committed, Files.readAllBytes(new File(root, "vault.enc").toPath()));
      JSONArray imported = reopened.entries();
      for (int i = 0; i < imported.length(); i++) reopened.delete(imported.getJSONObject(i).getString("id"));
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
      // Every write moves the revision. A stale or missing record writes nothing.
      JSONObject created = vault.commitEntry(null, 0, "Revised", "revision-user", Arrays.asList("https://revision.test"), secret);
      String revised = created.getString("id");
      assertEquals(1, created.getLong("revision"));
      assertFalse(created.has("password"));
      assertEquals(2, vault.commitEntry(revised, 1, "Renamed", "revision-user", Arrays.asList("https://revision.test"), null).getLong("revision"));
      assertEquals(secret, vault.get(revised).getString("password"));
      vault.saveEntry(revised, "Elsewhere", "revision-user", Arrays.asList("https://revision.test"), null);
      assertEquals(3, vault.get(revised).getLong("revision"));
      byte[] current = Files.readAllBytes(new File(root, "vault.enc").toPath());
      try { vault.commitEntry(revised, 2, "Lost", "revision-user", Arrays.asList("https://revision.test"), "must-not-replace"); fail("Stale revision overwrote"); }
      catch (PasswordVaultStore.RevisionConflict expected) {}
      try { vault.commitEntry("missing", 0, "Lost", "revision-user", Arrays.asList("https://revision.test"), "must-not-recreate"); fail("Missing record recreated"); }
      catch (PasswordVaultStore.RevisionConflict expected) {}
      assertArrayEquals(current, Files.readAllBytes(new File(root, "vault.enc").toPath()));
      // A record from before revisions is at revision 0, and the legacy writer moves it too.
      String older = vault.save(null, "https://older.test", "older-user", "synthetic-older");
      assertEquals(1, vault.get(older).getLong("revision"));
      vault.save(older, "https://older.test", "older-user", "synthetic-older-2");
      assertEquals(2, vault.get(older).getLong("revision"));
      // Destroy takes a readable vault and its key, reports nothing left, and can repeat.
      assertFalse(vault.unrecoverable());
      vault.destroy();
      assertFalse(keys.containsAlias(alias));
      assertFalse(new File(root, "vault.enc").exists());
      assertFalse(new File(root, "vault.enc.bak").exists());
      vault.destroy();
      assertEquals(0, vault.entries().length());
      vault.saveEntry(null, "After destroy", "fixture-user", Arrays.asList("https://example.test"), secret);
      assertEquals(1, new PasswordVaultStore(root, alias, aad, (PasswordVaultStore.KeyPolicy) null).entries().length());
    } finally {
      File[] files = root.listFiles(); if (files != null) for (File file : files) file.delete(); root.delete();
      if (keys.containsAlias(alias)) keys.deleteEntry(alias);
    }
  }
}
