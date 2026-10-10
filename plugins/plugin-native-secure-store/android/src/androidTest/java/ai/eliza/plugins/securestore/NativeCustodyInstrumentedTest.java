package ai.eliza.plugins.securestore;

import ai.eliza.plugins.securestore.nativeonly.PasswordVaultStore;
import ai.eliza.plugins.securestore.nativeonly.RuntimeCredentialStore;
import ai.eliza.plugins.securestore.nativeonly.KeystoreTextFrame;
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
  @Test public void textFramesKeepDeployedCiphertextAndOneColdKey() throws Exception {
    String alias = "eliza.text-frame-test." + UUID.randomUUID();
    KeyStore keys = KeyStore.getInstance("AndroidKeyStore"); keys.load(null);
    java.util.concurrent.ExecutorService workers = java.util.concurrent.Executors.newFixedThreadPool(8);
    try {
      // Produce the deployed host format independently, before constructing the shared codec.
      javax.crypto.KeyGenerator generator = javax.crypto.KeyGenerator.getInstance("AES", "AndroidKeyStore");
      generator.init(new android.security.keystore.KeyGenParameterSpec.Builder(alias,
        android.security.keystore.KeyProperties.PURPOSE_ENCRYPT | android.security.keystore.KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes("GCM").setEncryptionPaddings("NoPadding").build());
      javax.crypto.SecretKey key = generator.generateKey();
      String value = "[\"https://example.test/synthetic?q=保存\"]";
      javax.crypto.Cipher oldWriter = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding"); oldWriter.init(javax.crypto.Cipher.ENCRYPT_MODE, key);
      String oldFrame = android.util.Base64.encodeToString(oldWriter.getIV(), android.util.Base64.NO_WRAP) + ":"
        + android.util.Base64.encodeToString(oldWriter.doFinal(value.getBytes(StandardCharsets.UTF_8)), android.util.Base64.NO_WRAP);
      KeystoreTextFrame codec = new KeystoreTextFrame(alias, 800000);
      assertEquals(value, codec.open(oldFrame));
      assertNull(keys.getKey(alias, null).getEncoded());

      String next = codec.seal(value);
      String[] parts = next.split(":", -1);
      javax.crypto.Cipher oldReader = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
      oldReader.init(javax.crypto.Cipher.DECRYPT_MODE, key, new javax.crypto.spec.GCMParameterSpec(128,
        android.util.Base64.decode(parts[0], android.util.Base64.NO_WRAP)));
      assertEquals(value, new String(oldReader.doFinal(android.util.Base64.decode(parts[1], android.util.Base64.NO_WRAP)), StandardCharsets.UTF_8));
      byte[] tampered = android.util.Base64.decode(parts[1], android.util.Base64.NO_WRAP); tampered[0] ^= 1;
      try { codec.open(parts[0] + ":" + android.util.Base64.encodeToString(tampered, android.util.Base64.NO_WRAP)); fail("Accepted changed ciphertext"); }
      catch (javax.crypto.AEADBadTagException expected) {}
      KeystoreTextFrame small = new KeystoreTextFrame(alias, 41);
      assertEquals("", small.open(small.seal("")));
      try { small.seal("abc"); fail("Wrote a frame larger than the read limit"); } catch (IllegalArgumentException expected) {}
      try { small.open(next); fail("Accepted an oversized frame"); } catch (IllegalArgumentException expected) {}

      java.util.concurrent.CountDownLatch start = new java.util.concurrent.CountDownLatch(1);
      java.util.ArrayList<java.util.concurrent.Future<String>> written = new java.util.ArrayList<>();
      for (int i = 0; i < 8; i++) {
        final int id = i;
        written.add(workers.submit(() -> { start.await(); return new KeystoreTextFrame(alias + ".cold", 1000).seal("synthetic-" + id); }));
      }
      start.countDown();
      for (int i = 0; i < written.size(); i++) assertEquals("synthetic-" + i,
        new KeystoreTextFrame(alias + ".cold", 1000).open(written.get(i).get(30, java.util.concurrent.TimeUnit.SECONDS)));
    } finally {
      workers.shutdownNow(); workers.awaitTermination(30, java.util.concurrent.TimeUnit.SECONDS);
      keys.deleteEntry(alias); keys.deleteEntry(alias + ".cold");
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
