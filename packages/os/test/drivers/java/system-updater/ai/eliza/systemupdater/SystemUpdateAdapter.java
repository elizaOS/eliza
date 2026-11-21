// spec/os/update/updater.md, "Story: Install a verified update once"
package ai.eliza.systemupdater;

import ai.eliza.systemupdater.UpdateAdmission.Conditions;
import ai.eliza.systemupdater.UpdateAdmission.Engine;
import ai.eliza.systemupdater.UpdateAdmission.ManifestFacts;
import ai.eliza.systemupdater.UpdateAdmission.Offer;
import ai.eliza.systemupdater.UpdateAdmission.Release;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class SystemUpdateAdapter {
    private static final Map<UpdateJournal.Phase, String> PHASES = Map.ofEntries(
            Map.entry(UpdateJournal.Phase.IDLE, "Idle"), Map.entry(UpdateJournal.Phase.DOWNLOADING, "Downloading"),
            Map.entry(UpdateJournal.Phase.VERIFIED, "Verified"), Map.entry(UpdateJournal.Phase.APPLY_INTENT, "ApplyIntent"),
            Map.entry(UpdateJournal.Phase.APPLYING, "Applying"), Map.entry(UpdateJournal.Phase.REBOOT_READY, "RebootReady"),
            Map.entry(UpdateJournal.Phase.REBOOT_INTENT, "RebootIntent"), Map.entry(UpdateJournal.Phase.COMPLETE, "Complete"),
            Map.entry(UpdateJournal.Phase.SOURCE_RETAINED, "SourceRetained"), Map.entry(UpdateJournal.Phase.FAILED, "Failed"),
            Map.entry(UpdateJournal.Phase.UNKNOWN, "Unknown"));
    private static final Map<UpdateJournal.RestartHold, String> HOLDS = Map.of(
            UpdateJournal.RestartHold.NOT_HELD, "NotHeld", UpdateJournal.RestartHold.CONDITIONS, "HeldForConditions",
            UpdateJournal.RestartHold.OFFER_UNAVAILABLE, "HeldOfferUnavailable", UpdateJournal.RestartHold.NO_OFFER, "HeldNoOffer",
            UpdateJournal.RestartHold.OFFER_CHANGED, "HeldOfferChanged", UpdateJournal.RestartHold.ENGINE, "HeldForEngine");
    private static final Map<String, Engine> ENGINES = Map.of("EngineIdle", Engine.IDLE, "EngineBusy", Engine.BUSY,
            "EngineNeedsReboot", Engine.NEEDS_REBOOT, "EngineUnavailable", Engine.UNAVAILABLE);

    private final Map<String, String> labels = new HashMap<>();
    private UpdateJournal journal = UpdateJournal.idle();

    public static void main(String[] args) throws Exception {
        SystemUpdateAdapter adapter = new SystemUpdateAdapter();
        BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        PrintStream output = new PrintStream(System.out, true, StandardCharsets.UTF_8);
        for (String line; (line = input.readLine()) != null;) {
            if (line.isBlank()) continue;
            try { output.println(adapter.answer(line)); }
            catch (RuntimeException failure) { output.println("{\"error\":" + quote(String.valueOf(failure)) + "}"); }
        }
    }

    private String answer(String line) {
        Map<String, Object> request = object(new Json(line).value());
        Object event = request.containsKey("event") ? request.get("event") : request.get("raw");
        if (event == null) {
            journal = UpdateJournal.idle();
            return "{\"state\":" + encode() + "}";
        }
        boolean accepted;
        try {
            journal = step(object(event));
            accepted = true;
        } catch (IllegalStateException | IllegalArgumentException refused) {
            accepted = false;
        }
        return "{\"outcome\":\"" + (accepted ? "accepted" : "refused") + "\",\"state\":" + encode() + "}";
    }

    private UpdateJournal step(Map<String, Object> e) {
        String type = text(e.get("type"));
        return switch (type) {
            case "download" -> journal.download(release(e.get("installed")), release(e.get("candidate")),
                    digest(e.get("digest")), manifest(e.get("manifest")), conditions(e.get("conditions")));
            case "verify" -> journal.verified(release(e.get("installed")), release(e.get("candidate")), digest(e.get("digest")));
            case "reject" -> journal.failedBeforeApply();
            case "applyIntent" -> journal.applyIntent(text(e.get("boot")), engine(e.get("engine")),
                    conditions(e.get("conditions")), offer(e.get("offer")));
            case "withdrawApplyIntent" -> journal.withdrawApplyIntent(text(e.get("boot")), conditions(e.get("conditions")));
            case "applyAccepted" -> journal.applying(text(e.get("boot")));
            case "completedApply" -> journal.completedApply(text(e.get("boot")), Math.toIntExact(number(e.get("errorCode"))));
            case "rebootIntent" -> {
                Offer offer = offer(e.get("offer"));
                Engine engine = engine(e.get("engine"));
                yield journal.rebootIntent(conditions(e.get("conditions")), () -> offer, () -> engine);
            }
            case "withdrawRebootIntent" -> journal.withdrawRebootIntent(conditions(e.get("conditions")));
            case "holdRestart" -> {
                Offer offer = offer(e.get("offer"));
                Engine engine = engine(e.get("engine"));
                yield journal.holdRestart(conditions(e.get("conditions")), () -> offer, () -> engine);
            }
            case "reconcile" -> journal.reconcile(text(e.get("booted")), text(e.get("boot")));
            case "withdraw" -> journal.cancelUnapplied();
            default -> throw new IllegalArgumentException("unknown event " + type);
        };
    }

    private String digest(Object value) {
        String label = text(value);
        if (label.isEmpty()) return "";
        try {
            String hex = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(label.getBytes(StandardCharsets.UTF_8)));
            labels.put(hex, label);
            return hex;
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new AssertionError(impossible);
        }
    }

    private static Release release(Object value) {
        Map<String, Object> r = object(value);
        return new Release(text(r.get("fingerprint")), text(r.get("product")), text(r.get("device")),
                number(r.get("buildDate")), number(r.get("securityPatch")), number(r.get("vendorPatch")));
    }

    private static ManifestFacts manifest(Object value) {
        Map<String, Object> m = object(value);
        return new ManifestFacts(number(m.get("manifestBytes")), flag(m.get("https")), flag(m.get("enrolledHost")),
                flag(m.get("userInfo")), Math.toIntExact(number(m.get("redirects"))), number(m.get("packageBytes")));
    }

    private static Conditions conditions(Object value) {
        Map<String, Object> c = object(value);
        return new Conditions(flag(c.get("systemUser")), flag(c.get("unlocked")), flag(c.get("managedProfile")),
                flag(c.get("charging")), Math.toIntExact(number(c.get("batteryPercent"))), flag(c.get("unmeteredNetwork")),
                flag(c.get("updatePolicySet")), flag(c.get("screenOn")), flag(c.get("phoneStateGranted")), flag(c.get("inCall")));
    }

    private static Engine engine(Object value) {
        Engine engine = ENGINES.get(text(value));
        if (engine == null) throw new IllegalArgumentException("unknown engine status " + value);
        return engine;
    }

    private Offer offer(Object value) {
        Map<String, Object> o = object(value);
        return switch (text(o.get("tag"))) {
            case "NoOffer" -> Offer.NONE;
            case "OfferUnavailable" -> Offer.UNAVAILABLE;
            case "Offered" -> Offer.of(text(o.get("fingerprint")), digest(o.get("digest")));
            default -> throw new IllegalArgumentException("unknown offer " + o.get("tag"));
        };
    }

    private String encode() {
        String digest = journal.packageSha256.isEmpty() ? "" : labels.getOrDefault(journal.packageSha256, journal.packageSha256);
        return "{\"phase\":" + quote(PHASES.get(journal.phase)) + ",\"source\":" + quote(journal.sourceBuild)
                + ",\"target\":" + quote(journal.targetBuild) + ",\"digest\":" + quote(digest)
                + ",\"intentBoot\":" + quote(journal.intentBoot) + ",\"applyCalls\":" + journal.applyCalls
                + ",\"restartHold\":" + quote(HOLDS.get(journal.restartHold)) + "}";
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> object(Object value) {
        if (!(value instanceof Map)) throw new IllegalArgumentException("not an object: " + value);
        return (Map<String, Object>) value;
    }

    private static String text(Object value) {
        if (!(value instanceof String s)) throw new IllegalArgumentException("not a string: " + value);
        return s;
    }

    private static boolean flag(Object value) {
        if (!(value instanceof Boolean b)) throw new IllegalArgumentException("not a boolean: " + value);
        return b;
    }

    private static long number(Object value) {
        if (!(value instanceof Long n)) throw new IllegalArgumentException("not a whole number: " + value);
        return n;
    }

    private static String quote(String text) {
        return "\"" + text.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n") + "\"";
    }

    private static final class Json {
        private final String text;
        private int at;

        Json(String text) { this.text = text; }

        Object value() {
            skip();
            char c = text.charAt(at);
            if (c == '{') {
                Map<String, Object> out = new LinkedHashMap<>();
                at++;
                skip();
                if (text.charAt(at) == '}') { at++; return out; }
                do {
                    skip();
                    String key = (String) value();
                    skip();
                    if (text.charAt(at++) != ':') throw new IllegalArgumentException("expected : at " + at);
                    out.put(key, value());
                    skip();
                } while (text.charAt(at++) == ',');
                if (text.charAt(at - 1) != '}') throw new IllegalArgumentException("malformed object at " + at);
                return out;
            }
            if (c == '[') {
                List<Object> out = new ArrayList<>();
                at++;
                skip();
                if (text.charAt(at) == ']') { at++; return out; }
                do { out.add(value()); skip(); } while (text.charAt(at++) == ',');
                if (text.charAt(at - 1) != ']') throw new IllegalArgumentException("malformed array at " + at);
                return out;
            }
            if (c == '"') {
                StringBuilder out = new StringBuilder();
                for (at++; text.charAt(at) != '"'; at++) {
                    char ch = text.charAt(at);
                    if (ch != '\\') { out.append(ch); continue; }
                    char escaped = text.charAt(++at);
                    switch (escaped) {
                        case 'n' -> out.append('\n');
                        case 't' -> out.append('\t');
                        case 'r' -> out.append('\r');
                        case 'b' -> out.append('\b');
                        case 'f' -> out.append('\f');
                        case 'u' -> { out.append((char) Integer.parseInt(text.substring(at + 1, at + 5), 16)); at += 4; }
                        default -> out.append(escaped);
                    }
                }
                at++;
                return out.toString();
            }
            if (text.startsWith("true", at)) { at += 4; return Boolean.TRUE; }
            if (text.startsWith("false", at)) { at += 5; return Boolean.FALSE; }
            if (text.startsWith("null", at)) { at += 4; return null; }
            int start = at;
            while (at < text.length() && "+-0123456789.eE".indexOf(text.charAt(at)) >= 0) at++;
            String number = text.substring(start, at);
            if (number.isEmpty()) throw new IllegalArgumentException("unexpected " + c + " at " + start);
            return number.matches("-?[0-9]+") ? (Object) Long.parseLong(number) : (Object) Double.parseDouble(number);
        }

        private void skip() { while (at < text.length() && Character.isWhitespace(text.charAt(at))) at++; }
    }
}
