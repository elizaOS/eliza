package ai.eliza.plugins.passwords;

import ai.eliza.plugins.securestore.nativeonly.PasswordFacets;
import java.util.List;

/** Exact binding match between a stored entry and an admitted fill target. Pure Java. */
public final class PasswordMatching {
  private PasswordMatching() {}

  /** Rotation-aware signer check, normally {@code PackageManager#hasSigningCertificate}. */
  public interface SignerCheck { boolean signedBy(String packageName, String certificateSha256Hex); }

  public static boolean matches(List<String> bindings, PasswordFormPolicy.Target target, SignerCheck signers) {
    if (bindings == null || target == null) return false;
    for (String binding : bindings) {
      if (binding == null) continue;
      if (target.web()) {
        if (binding.equals(target.webOrigin)) return true;
      } else if (PasswordFacets.isAndroid(binding) && target.appPackage.equals(PasswordFacets.androidPackage(binding))) {
        // The package name alone is not an identity: a different publisher can reuse it.
        String certificate = PasswordFacets.androidCertificate(binding);
        if (signers != null && certificate != null && signers.signedBy(target.appPackage, certificate)) return true;
      }
    }
    return false;
  }
}
