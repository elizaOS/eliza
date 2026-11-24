// spec/os/update/updater.md, "Story: Install a verified update once"
package ai.eliza.systemupdater;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Map;
import org.json.JSONObject;

public final class JournalReplay {
    private static final long MAX_MANIFEST_BYTES = 65536;
    private static final int MAX_REDIRECTS = 3;
    private static final long MAX_PACKAGE_BYTES = 12L * 1024 * 1024 * 1024;

    private final Map<String, String> digests = new HashMap<>(Map.of("", ""));
    private UpdateJournal journal = UpdateJournal.idle();
    private UpdateJournal verifiedBeforeIntent;
    private UpdateJournal readyBeforeRestart;
    private int engineCalls;

    public static void main(String[] args) throws Exception {
        JournalReplay replay = new JournalReplay();
        BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        PrintStream output = new PrintStream(System.out, true, StandardCharsets.UTF_8);
        for (String line; (line = input.readLine()) != null;) {
            if (line.isBlank()) continue;
            try { output.println(replay.answer(new JSONObject(line))); }
            catch (RuntimeException failure) { output.println(new JSONObject().put("error", String.valueOf(failure))); }
        }
    }

    private JSONObject answer(JSONObject request) {
        if (!request.has("event")) {
            journal = UpdateJournal.idle();
            verifiedBeforeIntent = null;
            readyBeforeRestart = null;
            engineCalls = 0;
            return new JSONObject().put("state", state());
        }
        boolean accepted;
        try { accepted = step(request.getJSONObject("event")); }
        catch (IllegalStateException | IllegalArgumentException refused) { accepted = false; }
        return new JSONObject().put("outcome", accepted ? "accepted" : "refused").put("state", state());
    }

    private boolean step(JSONObject event) {
        String type = event.getString("type");
        switch (type) {
            case "download": {
                JSONObject installed = event.getJSONObject("installed"), candidate = event.getJSONObject("candidate");
                if (!downloadAllowed(event.getJSONObject("conditions")) || !manifestAdmitted(event.getJSONObject("manifest"))
                        || !offered(installed, candidate)) return false;
                journal = journal.download(installed.getString("fingerprint"), candidate.getString("fingerprint"),
                        sha256(event.getString("digest")));
                engineCalls = 0;
                return true;
            }
            case "verify": {
                JSONObject installed = event.getJSONObject("installed"), candidate = event.getJSONObject("candidate");
                if (!offered(installed, candidate) || !patchLevelsKept(installed, candidate)) return false;
                journal = journal.verified(installed.getString("fingerprint"), candidate.getString("fingerprint"),
                        sha256(event.getString("digest")));
                return true;
            }
            case "reject":
                journal = journal.failedBeforeApply();
                return true;
            case "applyIntent": {
                if (!installAllowed(event.getJSONObject("conditions")) || !offerMatches(event.getJSONObject("offer"))) return false;
                UpdateJournal verified = journal;
                journal = journal.applyIntent(event.getString("boot"), "EngineIdle".equals(event.getString("engine")));
                verifiedBeforeIntent = verified;
                return true;
            }
            case "withdrawApplyIntent":
                if (journal.phase != UpdateJournal.Phase.APPLY_INTENT
                        || (journal.intentBoot.equals(event.getString("boot")) && installAllowed(event.getJSONObject("conditions")))) {
                    return false;
                }
                journal = verifiedBeforeIntent;
                return true;
            case "applyAccepted": {
                UpdateJournal applying = journal.applying(event.getString("boot"));
                engineCalls++;
                journal = applying;
                return true;
            }
            case "completedApply": {
                if (journal.phase != UpdateJournal.Phase.APPLYING) return false;
                String boot = event.getString("boot");
                try { journal = journal.completedApply(boot, journal.intentBoot.equals(boot), event.getInt("errorCode")); }
                catch (IllegalStateException anotherBoot) { journal = journal.reconcile(journal.sourceBuild, boot); }
                return true;
            }
            case "holdRestart":
                return journal.phase == UpdateJournal.Phase.REBOOT_READY && !(installAllowed(event.getJSONObject("conditions"))
                        && offerMatches(event.getJSONObject("offer")) && "EngineNeedsReboot".equals(event.getString("engine")));
            case "rebootIntent": {
                if (!offerMatches(event.getJSONObject("offer"))) return false;
                UpdateJournal ready = journal;
                journal = journal.rebootIntent(installAllowed(event.getJSONObject("conditions")),
                        "EngineNeedsReboot".equals(event.getString("engine")));
                readyBeforeRestart = ready;
                return true;
            }
            case "withdrawRebootIntent":
                if (journal.phase != UpdateJournal.Phase.REBOOT_INTENT || installAllowed(event.getJSONObject("conditions"))) return false;
                journal = readyBeforeRestart;
                return true;
            case "reconcile":
                if (journal.phase == UpdateJournal.Phase.IDLE) return false;
                journal = journal.reconcile(event.getString("booted"), event.getString("boot"));
                return true;
            case "withdraw":
                journal = journal.cancelUnapplied();
                engineCalls = 0;
                return true;
            default:
                throw new UnsupportedOperationException("not an updater event: " + type);
        }
    }

    private static boolean downloadAllowed(JSONObject conditions) {
        return conditions.getBoolean("systemUser") && conditions.getBoolean("unlocked") && !conditions.getBoolean("managedProfile")
                && (conditions.getBoolean("charging") || conditions.getInt("batteryPercent") >= 50)
                && conditions.getBoolean("unmeteredNetwork") && !conditions.getBoolean("updatePolicySet");
    }

    private static boolean installAllowed(JSONObject conditions) {
        return downloadAllowed(conditions) && !conditions.getBoolean("screenOn") && conditions.getBoolean("phoneStateGranted")
                && !conditions.getBoolean("inCall");
    }

    private static boolean manifestAdmitted(JSONObject manifest) {
        long bytes = manifest.getLong("manifestBytes"), packageBytes = manifest.getLong("packageBytes");
        int redirects = manifest.getInt("redirects");
        return bytes > 0 && bytes <= MAX_MANIFEST_BYTES && manifest.getBoolean("https") && manifest.getBoolean("enrolledHost")
                && !manifest.getBoolean("userInfo") && redirects >= 0 && redirects <= MAX_REDIRECTS
                && packageBytes > 0 && packageBytes <= MAX_PACKAGE_BYTES;
    }

    private static boolean offered(JSONObject installed, JSONObject candidate) {
        return candidate.getString("product").equals(installed.getString("product"))
                && candidate.getString("device").equals(installed.getString("device"))
                && candidate.getLong("buildDate") > installed.getLong("buildDate")
                && !candidate.getString("fingerprint").equals(installed.getString("fingerprint"));
    }

    private static boolean patchLevelsKept(JSONObject installed, JSONObject candidate) {
        return candidate.getLong("securityPatch") >= installed.getLong("securityPatch")
                && candidate.getLong("vendorPatch") >= installed.getLong("vendorPatch");
    }

    private boolean offerMatches(JSONObject offer) {
        return "Offered".equals(offer.getString("tag")) && offer.getString("fingerprint").equals(journal.targetBuild)
                && sha256(offer.getString("digest")).equals(journal.packageSha256);
    }

    private String sha256(String digest) {
        if (digest.isEmpty()) return digest;
        try {
            String hex = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(digest.getBytes(StandardCharsets.UTF_8)));
            digests.put(hex, digest);
            return hex;
        } catch (NoSuchAlgorithmException unavailable) {
            throw new UnsupportedOperationException(unavailable);
        }
    }

    private JSONObject state() {
        StringBuilder phase = new StringBuilder();
        for (String word : journal.phase.name().split("_")) phase.append(word.charAt(0)).append(word.substring(1).toLowerCase(Locale.ROOT));
        return new JSONObject().put("phase", phase.toString()).put("source", journal.sourceBuild).put("target", journal.targetBuild)
                .put("digest", digests.getOrDefault(journal.packageSha256, journal.packageSha256))
                .put("intentBoot", journal.intentBoot).put("applyCalls", engineCalls);
    }
}
