// SPDX-License-Identifier: MIT
// spec/os/update/updater.md, "A candidate is admitted only for the same product and device, with a newer build and no lower patch levels"; spec/os/update/updater.md, "A download needs the download conditions and an install or restart also needs an idle phone"; spec/os/update/updater.md, "An apply intent is persisted before the one apply call, and only for a verified candidate the offer still matches"
package ai.eliza.systemupdater;

final class UpdateAdmission {
    static final int MAX_MANIFEST_BYTES = 65_536;
    static final int MAX_REDIRECTS = 3;
    static final long MAX_PACKAGE_BYTES = 12L * 1024 * 1024 * 1024;
    static final int MIN_UNPLUGGED_BATTERY_PERCENT = 50;

    private UpdateAdmission() { }

    record Release(String fingerprint, String product, String device,
            long buildDate, long securityPatch, long vendorPatch) { }

    record ManifestFacts(long manifestBytes, boolean https, boolean enrolledHost, boolean userInfo,
            int redirects, long packageBytes) {
        boolean admitted() {
            return manifestBytes > 0 && manifestBytes <= MAX_MANIFEST_BYTES && https && enrolledHost && !userInfo
                    && redirects >= 0 && redirects <= MAX_REDIRECTS && packageBytes > 0 && packageBytes <= MAX_PACKAGE_BYTES;
        }
    }

    record Conditions(boolean systemUser, boolean unlocked, boolean managedProfile, boolean charging,
            int batteryPercent, boolean unmeteredNetwork, boolean updatePolicySet, boolean screenOn,
            boolean phoneStateGranted, boolean inCall) {
        boolean downloadAllowed() {
            return systemUser && unlocked && !managedProfile
                    && (charging || batteryPercent >= MIN_UNPLUGGED_BATTERY_PERCENT)
                    && unmeteredNetwork && !updatePolicySet;
        }

        boolean installAllowed() { return downloadAllowed() && !screenOn && phoneStateGranted && !inCall; }
    }

    enum Engine { IDLE, BUSY, NEEDS_REBOOT, UNAVAILABLE }

    record Offer(Kind kind, String fingerprint, String digest) {
        enum Kind { NONE, UNAVAILABLE, OFFERED }
        static final Offer NONE = new Offer(Kind.NONE, "", "");
        static final Offer UNAVAILABLE = new Offer(Kind.UNAVAILABLE, "", "");

        static Offer of(String fingerprint, String digest) { return new Offer(Kind.OFFERED, fingerprint, digest); }

        boolean names(String target, String sha256) {
            return kind == Kind.OFFERED && fingerprint.equals(target) && digest.equals(sha256);
        }
    }

    static boolean offered(Release installed, Release candidate) {
        return !candidate.fingerprint().isEmpty() && !candidate.fingerprint().equals(installed.fingerprint())
                && candidate.product().equals(installed.product()) && candidate.device().equals(installed.device())
                && candidate.buildDate() > installed.buildDate();
    }

    static boolean candidateAdmitted(Release installed, Release candidate) {
        return offered(installed, candidate) && candidate.securityPatch() >= installed.securityPatch()
                && candidate.vendorPatch() >= installed.vendorPatch();
    }

    static long patchLevel(String value) {
        if (value == null || !value.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}")) {
            throw new IllegalArgumentException("Patch level is not YYYY-MM-DD");
        }
        return Long.parseLong(value.replace("-", ""));
    }
}
