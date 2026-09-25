package ai.eliza.plugins.browsersurface;

/** Package and signer are one build-selected identity; never search other browsers. */
public final class ChromiumBrowserIdentity {
    private ChromiumBrowserIdentity() {}

    @FunctionalInterface
    public interface SigningCertificateLookup {
        boolean matches(String packageName, byte[] certificateSha256);
    }

    public static boolean isAllowedPackage(String packageName) {
        return "org.chromium.chrome".equals(packageName) || "ai.elizaos.chromium".equals(packageName);
    }

    public static boolean isTrustedPackage(String packageName, String digest, SigningCertificateLookup lookup) {
        if (!isAllowedPackage(packageName) || digest == null || !digest.matches("[a-fA-F0-9]{64}")) return false;
        byte[] certificate = new byte[32];
        for (int i = 0; i < certificate.length; i++) {
            certificate[i] = (byte) Integer.parseInt(digest.substring(i * 2, i * 2 + 2), 16);
        }
        return lookup.matches(packageName, certificate);
    }

    public static boolean isTrustedCaller(String[] callerPackages, String selectedPackage, String digest,
            SigningCertificateLookup lookup) {
        if (callerPackages == null) return false;
        for (String callerPackage : callerPackages) {
            if (selectedPackage != null && selectedPackage.equals(callerPackage)) {
                return isTrustedPackage(selectedPackage, digest, lookup);
            }
        }
        return false;
    }
}
