package ai.eliza.plugins.passwords;

import android.content.Context;
import android.content.pm.PackageManager;
import android.content.res.Resources;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/** Host identity and policy, read from overridable {@code eliza_passwords_*} resources. */
public final class PasswordsConfig {
  public final File directory;
  public final String alias, tokenScheme, hostPackage;
  public final byte[] aad;
  public final int unlockSeconds;
  public final boolean biometric, hostIsBrowser;
  private final Map<String, String> trustedBrowsers = new HashMap<>();

  private PasswordsConfig(Context context) {
    Context app = context.getApplicationContext();
    Resources resources = app.getResources();
    String name = resources.getString(R.string.eliza_passwords_vault_directory);
    if (!name.matches("[A-Za-z0-9._-]{1,64}") || name.startsWith(".")) throw new IllegalStateException("Invalid password vault directory");
    directory = new File(app.getNoBackupFilesDir(), name);
    alias = resources.getString(R.string.eliza_passwords_key_alias);
    aad = resources.getString(R.string.eliza_passwords_vault_aad).getBytes(StandardCharsets.UTF_8);
    unlockSeconds = resources.getInteger(R.integer.eliza_passwords_unlock_seconds);
    if (unlockSeconds < 15 || unlockSeconds > 300) throw new IllegalStateException("Unsupported password unlock window");
    biometric = resources.getBoolean(R.bool.eliza_passwords_allow_biometric);
    hostIsBrowser = resources.getBoolean(R.bool.eliza_passwords_host_is_browser);
    tokenScheme = resources.getString(R.string.eliza_passwords_token_scheme);
    if (!tokenScheme.matches("[a-z][a-z0-9+.-]{0,40}")) throw new IllegalStateException("Invalid password token scheme");
    hostPackage = app.getPackageName();
    for (String entry : resources.getStringArray(R.array.eliza_passwords_trusted_browsers)) {
      int split = entry.lastIndexOf(':');
      String cert = split < 0 ? "" : entry.substring(split + 1).toLowerCase(Locale.ROOT);
      if (split <= 0 || !cert.matches("[a-f0-9]{64}")) throw new IllegalStateException("Invalid trusted browser entry");
      trustedBrowsers.put(entry.substring(0, split), cert);
    }
  }

  private static PasswordsConfig instance;
  public static synchronized PasswordsConfig of(Context context) {
    if (instance == null) instance = new PasswordsConfig(context);
    return instance;
  }

  /** Allowlisted, certificate-verified browsers only. The host is handled by {@link #hostIsBrowser}. */
  public boolean trustedBrowser(Context context, String packageName) {
    String cert = trustedBrowsers.get(packageName);
    if (cert == null || packageName.equals(hostPackage)) return false;
    return signedBy(context, packageName, cert);
  }

  static boolean signedBy(Context context, String packageName, String certificateSha256) {
    try {
      byte[] digest = new byte[32];
      for (int i = 0; i < 32; i++) digest[i] = (byte) Integer.parseInt(certificateSha256.substring(i * 2, i * 2 + 2), 16);
      return context.getPackageManager().hasSigningCertificate(packageName, digest, PackageManager.CERT_INPUT_SHA256);
    } catch (RuntimeException unavailable) { return false; }
  }
}
