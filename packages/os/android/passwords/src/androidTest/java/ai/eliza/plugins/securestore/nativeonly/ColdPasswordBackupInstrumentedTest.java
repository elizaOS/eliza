package ai.eliza.plugins.securestore.nativeonly;

import android.app.KeyguardManager;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.cert.CertificateFactory;
import java.util.Arrays;
import java.util.Base64;
import java.util.List;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

public final class ColdPasswordBackupInstrumentedTest {
  private static final String CLIENT = "com.example.consumer";
  private static final String CLOUD = "https://127.0.0.1";
  private static final String BROWSER = "https://localhost";
  private static final String CALLBACK = "/android/auth/callback";
  private static final String SITE = "https://fixture-bill.example.test";
  private static final String SECRET = "synthetic-cold-recovery-password-7Q";
  private static final byte[] AAD = "cold-password-recovery-fixture".getBytes(StandardCharsets.US_ASCII);

  @Test public void restoreAfterColdStart() throws Exception {
    var arguments = InstrumentationRegistry.getArguments();
    String phase = arguments.getString("coldPasswordPhase");
    assumeTrue(phase != null);
    assertTrue("Choose the save or restore phase", "save".equals(phase) || "restore".equals(phase));
    assertTrue("The fixture needs Android 15 or later", Build.VERSION.SDK_INT >= 35);
    Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    KeyguardManager lock = context.getSystemService(KeyguardManager.class);
    assertTrue("Start with a secure, unlocked fixture device", lock.isDeviceSecure() && !lock.isDeviceLocked());

    var original = HttpsURLConnection.getDefaultSSLSocketFactory();
    HttpsURLConnection.setDefaultSSLSocketFactory(fixtureTls(arguments.getString("coldPasswordCertificate")).getSocketFactory());
    CloudDeviceAccount account = new CloudDeviceAccount(context, BROWSER, CLOUD, CALLBACK);
    PasswordVaultStore vault = new PasswordVaultStore(new File(context.getNoBackupFilesDir(), "cold-password-" + phase),
      "eliza.passwords.cold-fixture." + phase, AAD, PasswordVaultStore.KeyPolicy.deviceUnlocked(context));
    byte[] recoveryKey = MessageDigest.getInstance("SHA-256").digest(AAD);
    try {
      assertNull("A cold phase starts without an existing device grant", account.session());
      assertTrue("The cold device permits device-only access", account.isDeviceOnly());
      assertFalse("The receiving vault starts empty", vault.exists());
      Uri enrollment = account.begin();
      assertFalse("Pending enrollment closes device-only access", account.isDeviceOnly());
      Uri activation = browserReturn("enroll", enrollment);
      assertTrue("The device must redeem and acknowledge a real grant", account.exchange(activation));
      assertFalse("The acknowledged account closes device-only access", account.isDeviceOnly());
      CloudPasswordBackup backup = new CloudPasswordBackup(account, CLIENT, "staging");
      assertTrue("The disposable authenticated Worker must be ready", backup.available());
      boolean save = "save".equals(phase);
      var purpose = save ? PasswordBackupApproval.Purpose.SAVE : PasswordBackupApproval.Purpose.READ;
      var approval = backup.exchange(browserReturn("approve", backup.begin(purpose)), purpose, () -> true);
      if (save) {
        assertFalse(approval.present());
        vault.saveEntry(null, "Fixture bill", "fixture-owner", List.of(SITE), SECRET);
        byte[] encrypted = vault.encryptBackup(approval.scope(), recoveryKey);
        try {
          assertFalse(new String(encrypted, StandardCharsets.ISO_8859_1).contains(SECRET));
          assertEquals(204, approval.run(null, encrypted).status());
        } finally {
          Arrays.fill(encrypted, (byte) 0);
        }
      } else {
        assertTrue("Cloud must retain the backup across Android test runs", approval.present());
        var result = approval.run(null, null);
        assertEquals(200, result.status());
        assertEquals(approval.revision(), result.revision());
        byte[] encrypted = result.ciphertext();
        try {
          assertEquals(1, vault.restoreBackup(approval.scope(), recoveryKey, encrypted));
          JSONObject entry = vault.entries().getJSONObject(0);
          assertEquals("fixture-owner", entry.getString("username"));
          assertEquals(List.of(SITE), PasswordVaultStore.bindings(entry));
          assertTrue("The restored login must contain the original fixture credential",
            SECRET.equals(vault.get(entry.getString("id")).getString("password")));
        } finally {
          Arrays.fill(encrypted, (byte) 0);
        }
      }
      account.clear();
      assertFalse("The previous grant retires on sign-out", approval.current());
      account.retryRevocation();
    } finally {
      Arrays.fill(recoveryKey, (byte) 0);
      try {
        try { account.clear(); }
        finally { vault.destroy(); }
      } finally {
        HttpsURLConnection.setDefaultSSLSocketFactory(original);
      }
    }
  }

  private static SSLContext fixtureTls(String encodedCertificate) throws Exception {
    assertTrue("Provide the disposable fixture TLS certificate", encodedCertificate != null && encodedCertificate.length() <= 8192);
    var bytes = Base64.getDecoder().decode(encodedCertificate);
    var certificate = CertificateFactory.getInstance("X.509").generateCertificate(new ByteArrayInputStream(bytes));
    KeyStore pinned = KeyStore.getInstance(KeyStore.getDefaultType());
    pinned.load(null);
    pinned.setCertificateEntry("cold-password-fixture", certificate);
    TrustManagerFactory trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
    trust.init(pinned);
    SSLContext tls = SSLContext.getInstance("TLS");
    tls.init(null, trust.getTrustManagers(), null);
    return tls;
  }

  private static Uri browserReturn(String action, Uri address) throws Exception {
    var request = (HttpsURLConnection) URI.create(CLOUD + "/__fixture/browser").toURL().openConnection();
    request.setRequestMethod("POST");
    request.setInstanceFollowRedirects(false);
    request.setConnectTimeout(5000);
    request.setReadTimeout(10000);
    request.setRequestProperty("Content-Type", "application/json");
    byte[] input = new JSONObject().put("action", action).put("address", address.toString()).toString().getBytes(StandardCharsets.UTF_8);
    request.setDoOutput(true);
    request.setFixedLengthStreamingMode(input.length);
    try {
      try (var stream = request.getOutputStream()) { stream.write(input); }
      assertEquals("The fixture browser must complete an approved operation", 200, request.getResponseCode());
      try (var stream = request.getInputStream()) {
        byte[] bytes = stream.readNBytes(8193);
        assertTrue(bytes.length <= 8192);
        return Uri.parse(new JSONObject(new String(bytes, StandardCharsets.UTF_8)).getString("redirectUrl"));
      }
    } finally {
      request.disconnect();
    }
  }
}
