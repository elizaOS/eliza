package ai.eliza.plugins.securestore;

import ai.eliza.plugins.securestore.nativeonly.PasswordVaultStore;
import ai.eliza.plugins.securestore.nativeonly.RuntimeCredentialStore;
import ai.eliza.plugins.securestore.nativeonly.PasswordAutofillPolicy;
import ai.eliza.plugins.securestore.nativeonly.PasswordAutofillSessions;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.filters.SdkSuppress;
import org.junit.Test;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyStore;
import java.util.List;
import java.util.UUID;
import static org.junit.Assert.*;

/** Synthetic credentials only. Real Android Keystore, no renderer or network. */
@SdkSuppress(minSdkVersion = 28)
public final class NativeCustodyInstrumentedTest {
  @Test public void hostIdentityAndBackupRecovery() throws Exception {
    File root = new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getNoBackupFilesDir(), "native-custody-" + UUID.randomUUID());
    assertTrue(root.mkdir());
    String alias = "eliza.native-test." + UUID.randomUUID();
    byte[] aad = "fixture-host/credential/v1".getBytes(StandardCharsets.UTF_8);
    KeyStore keys = KeyStore.getInstance("AndroidKeyStore"); keys.load(null);
    try {
      RuntimeCredentialStore credential = new RuntimeCredentialStore(root, alias, "credential.enc", aad, false);
      String value = "fixture-synthetic-account-credential";
      credential.write(value);
      File encrypted = new File(root, "credential.enc"), backup = new File(root, "credential.enc.bak");
      assertFalse(new String(Files.readAllBytes(encrypted.toPath()), StandardCharsets.UTF_8).contains(value));
      assertNull(keys.getKey(alias, null).getEncoded());
      Files.move(encrypted.toPath(), backup.toPath());
      assertEquals(value, new RuntimeCredentialStore(root, alias, "credential.enc", aad, false).read());
      assertTrue(encrypted.exists()); assertFalse(backup.exists());
      try { new RuntimeCredentialStore(root, alias, "credential.enc", "wrong-host".getBytes(StandardCharsets.UTF_8), false).read(); fail("Wrong AAD accepted"); } catch (javax.crypto.AEADBadTagException expected) {}
      byte[] corrupt = Files.readAllBytes(encrypted.toPath()); corrupt[corrupt.length - 1] ^= 1; Files.write(encrypted.toPath(), corrupt);
      try { credential.read(); fail("Tampered ciphertext accepted"); } catch (javax.crypto.AEADBadTagException expected) {}
      credential.clear(); assertNull(credential.read());
      PasswordVaultStore vault = new PasswordVaultStore(root, alias + ".vault", aad, false);
      String id = vault.save(null, "https://example.test:443/", "fixture-user", "fixture-password");
      assertEquals("https://example.test", vault.get(id).getString("origin"));
      assertFalse(vault.list().getJSONObject(0).has("password"));
      vault.delete(id); assertEquals(0, vault.list().length());
    } finally {
      for (File file : root.listFiles()) file.delete(); root.delete();
      keys.deleteEntry(alias); keys.deleteEntry(alias + ".vault");
    }
  }
  @Test public void exactOriginAndRevocableOneShotSessions() throws Exception {
    String origin = "https://example.test:8443";
    List<PasswordAutofillPolicy.Field> fields = List.of(
      new PasswordAutofillPolicy.Field(origin, "https", "example.test", List.of("username"), true, true),
      new PasswordAutofillPolicy.Field(origin, "https", "example.test", List.of("current-password"), true, false));
    assertEquals(origin, PasswordAutofillPolicy.validate(1, origin, origin, fields));
    try { PasswordAutofillPolicy.validate(1, origin, "https://example.test", fields); fail("Port mismatch accepted"); } catch (IllegalArgumentException expected) {}
    String token = PasswordAutofillSessions.create(null);
    PasswordAutofillSessions.Session session = PasswordAutofillSessions.take(token);
    assertNotNull(session); assertNull(PasswordAutofillSessions.take(token));
    PasswordAutofillSessions.cancel(token); assertFalse(session.valid());
  }
}
