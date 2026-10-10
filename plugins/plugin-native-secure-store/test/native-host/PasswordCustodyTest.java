import ai.eliza.plugins.securestore.nativeonly.PasswordFacets;
import ai.eliza.plugins.securestore.nativeonly.PasswordVaultFrame;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;

/** JVM tests for the vault ciphertext frame and binding normalization, using a software
 * AES key and synthetic plaintext only. Keystore enforcement is covered on device. */
public final class PasswordCustodyTest {
  private static int checks;
  private static void check(boolean value) { checks++; if (!value) throw new AssertionError("Check " + checks); }
  private interface Failing { void run() throws Exception; }
  private static void rejects(Failing body) {
    checks++;
    try { body.run(); } catch (Exception expected) { return; }
    throw new AssertionError("Check " + checks + " should have been rejected");
  }
  public static void main(String[] args) throws Exception {
    KeyGenerator generator = KeyGenerator.getInstance("AES"); generator.init(256);
    SecretKey key = generator.generateKey(), other = generator.generateKey();
    byte[] aad = "eliza.passwords.test.v1".getBytes(StandardCharsets.UTF_8);
    byte[] plaintext = "[{\"id\":\"synthetic\",\"password\":\"synthetic-not-a-secret\"}]".getBytes(StandardCharsets.UTF_8);

    byte[] frame = PasswordVaultFrame.seal(key, aad, plaintext);
    check(frame[0] == 1 && frame.length == 1 + 12 + plaintext.length + 16);
    check(Arrays.equals(PasswordVaultFrame.open(key, aad, frame), plaintext));
    // Plaintext never appears in the frame.
    check(!new String(frame, StandardCharsets.ISO_8859_1).contains("synthetic-not-a-secret"));
    // Fresh IV per seal: equal plaintext yields different frames.
    byte[] second = PasswordVaultFrame.seal(key, aad, plaintext);
    check(!Arrays.equals(Arrays.copyOfRange(frame, 1, 13), Arrays.copyOfRange(second, 1, 13)) && !Arrays.equals(frame, second));
    rejects(() -> PasswordVaultFrame.open(other, aad, frame));
    rejects(() -> PasswordVaultFrame.open(key, "other.aad".getBytes(StandardCharsets.UTF_8), frame));
    for (int index : new int[]{1, 12, 13, frame.length - 1}) {
      byte[] tampered = frame.clone(); tampered[index] ^= 1;
      rejects(() -> PasswordVaultFrame.open(key, aad, tampered));
    }
    byte[] wrongVersion = frame.clone(); wrongVersion[0] = 2;
    rejects(() -> PasswordVaultFrame.open(key, aad, wrongVersion));
    rejects(() -> PasswordVaultFrame.open(key, aad, Arrays.copyOf(frame, PasswordVaultFrame.MIN_FRAME_BYTES - 1)));
    rejects(() -> PasswordVaultFrame.open(key, aad, Arrays.copyOf(frame, frame.length - 1)));
    rejects(() -> PasswordVaultFrame.seal(key, aad, new byte[0]));
    rejects(() -> PasswordVaultFrame.seal(key, aad, new byte[PasswordVaultFrame.MAX_FRAME_BYTES]));
    check(PasswordVaultFrame.MIN_FRAME_BYTES == 30); // Matches the deployed minimum frame length.

    // Web origins: exact, normalized, HTTPS only, no path/query/fragment/userinfo.
    check(PasswordFacets.web("https://Example.COM").equals("https://example.com"));
    check(PasswordFacets.web(" https://example.com/ ").equals("https://example.com"));
    check(PasswordFacets.web("https://example.com:443").equals("https://example.com"));
    check(PasswordFacets.web("https://example.com:8443").equals("https://example.com:8443"));
    check(PasswordFacets.web("https://example.com.").equals("https://example.com"));
    check(PasswordFacets.web("https://xn--bcher-kva.example").equals("https://xn--bcher-kva.example"));
    for (String bad : new String[]{"http://example.com", "https://example.com/login", "https://example.com?next=1", "https://example.com#x",
        "https://user:pw@example.com", "example.com", "javascript:alert(1)", "https://", "https://exa mple.com", "https://bücher.example",
        "https://-bad.example", "https://example.com:99999", "file:///etc/passwd", "android://" + "a".repeat(64) + "@com.example.app"}) {
      rejects(() -> PasswordFacets.web(bad));
    }
    check(PasswordFacets.webDomain("https", "Accounts.Example.com").equals("https://accounts.example.com"));
    rejects(() -> PasswordFacets.webDomain("http", "example.com"));
    rejects(() -> PasswordFacets.webDomain(null, "example.com"));
    rejects(() -> PasswordFacets.webDomain("https", "example.com/path"));
    rejects(() -> PasswordFacets.webDomain("https", "user@example.com"));
    // Subdomains and sibling origins are distinct facets: matching is exact equality.
    check(!PasswordFacets.web("https://accounts.example.com").equals(PasswordFacets.web("https://example.com")));
    check(!PasswordFacets.web("https://example.com.evil.test").equals(PasswordFacets.web("https://example.com")));

    String cert = "AB".repeat(32);
    String app = PasswordFacets.android("com.example.app", cert);
    check(app.equals("android://" + "ab".repeat(32) + "@com.example.app"));
    check(PasswordFacets.isAndroid(app) && !PasswordFacets.isWeb(app));
    check("com.example.app".equals(PasswordFacets.androidPackage(app)) && ("ab".repeat(32)).equals(PasswordFacets.androidCertificate(app)));
    check(PasswordFacets.normalize(app).equals(app) && PasswordFacets.normalize("https://EXAMPLE.com/").equals("https://example.com"));
    rejects(() -> PasswordFacets.android("noperiod", cert));
    rejects(() -> PasswordFacets.android("com.example.app", "ab"));
    rejects(() -> PasswordFacets.android("com.example.app", "zz".repeat(32)));
    rejects(() -> PasswordFacets.normalize("android://" + "ab".repeat(32) + "@com.example.app/../x"));
    rejects(() -> PasswordFacets.normalize(null));
    System.out.println(checks + " assertions passed");
  }
}
