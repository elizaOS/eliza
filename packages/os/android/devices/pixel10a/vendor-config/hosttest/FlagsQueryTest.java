package ai.elizaresearch.pixelconfig;

import java.io.BufferedReader;
import java.io.StringReader;
import java.util.List;
import java.util.Map;

/** Host-JVM check of the vendor flags file rules and the Gservices key/prefix matching.
 * Not provider, caller-UID, cursor or device evidence. */
public final class FlagsQueryTest {
    private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
    private static Map<String, String> parse(String text) throws Exception { return FlagsQuery.parse(new BufferedReader(new StringReader(text))); }
    private static void refused(String text, String message) throws Exception {
        try { parse(text); } catch (IllegalStateException expected) { return; }
        throw new AssertionError(message);
    }
    private static String keys(List<String[]> rows) {
        StringBuilder out = new StringBuilder();
        for (String[] row : rows) out.append(out.length() == 0 ? "" : ",").append(row[0]);
        return out.toString();
    }

    public static void main(String[] args) throws Exception {
        Map<String, String> flags = parse("# extracted\n\n euiccpixel.experiment.Ota__should_enable_esim_gc_recovery true \neuicc.download_timeout 30 s\neuiccpixel.b 1\n");
        check(flags.size() == 3, "comments and blank lines are skipped");
        check("true".equals(flags.get("euiccpixel.experiment.Ota__should_enable_esim_gc_recovery")), "lines are trimmed");
        check("30 s".equals(flags.get("euicc.download_timeout")), "the value is everything after the first space");
        try { flags.put("euicc.x", "y"); throw new AssertionError("mutable flags"); } catch (UnsupportedOperationException expected) { /* read-only */ }

        refused("euicc.only_key\n", "a key without a value");
        refused(" euicc.a 1\neuicc.a 2\n", "a duplicate key");
        refused("gms.other 1\n", "a key outside the eSIM namespaces");
        refused("euiccx.a 1\n", "a namespace that only shares a prefix");
        StringBuilder many = new StringBuilder();
        for (int i = 0; i < 513; i++) many.append("euicc.k").append(i).append(" v\n");
        refused(many.toString(), "more than 512 flags");
        check(parse(many.substring(0, many.lastIndexOf("euicc.k512"))).size() == 512, "512 flags fit");

        check(FlagsQuery.supportedPath("") && FlagsQuery.supportedPath("/") && FlagsQuery.supportedPath("/prefix"), "key and prefix paths");
        check(!FlagsQuery.supportedPath("/prefix/") && !FlagsQuery.supportedPath("/other"), "other paths are refused");

        String key = "euiccpixel.experiment.Ota__should_enable_esim_gc_recovery";
        List<String[]> one = FlagsQuery.select(flags, "", new String[]{key, "euicc.download_timeout"});
        check(one.size() == 1 && key.equals(one.get(0)[0]) && "true".equals(one.get(0)[1]), "a key query reads only the first argument");
        check(FlagsQuery.select(flags, "/", new String[]{"euicc."}).isEmpty(), "a key query never matches a prefix");
        check(FlagsQuery.select(flags, "/", new String[]{"unknown.flag"}).isEmpty(), "an absent key returns no rows");
        check(FlagsQuery.select(flags, "", null).isEmpty() && FlagsQuery.select(flags, "/prefix", new String[0]).isEmpty(), "no arguments return no rows");
        check("euicc.download_timeout,euiccpixel.b,euiccpixel.experiment.Ota__should_enable_esim_gc_recovery".equals(keys(FlagsQuery.select(flags, "/prefix", new String[]{"euicc.", "euiccpixel."}))), "prefix rows come once each in key order");
        check("euiccpixel.b".equals(keys(FlagsQuery.select(flags, "/prefix", new String[]{null, "euiccpixel.b"}))), "a null prefix is ignored");
        try { FlagsQuery.select(flags, "/prefix", new String[65]); throw new AssertionError("65 prefixes"); } catch (IllegalArgumentException expected) { /* bounded */ }
        check(FlagsQuery.select(flags, "/prefix", new String[64]).isEmpty(), "64 prefixes are allowed");
        System.out.println("PASS flags query");
    }
}
