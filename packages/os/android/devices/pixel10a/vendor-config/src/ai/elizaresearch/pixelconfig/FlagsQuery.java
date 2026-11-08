package ai.elizaresearch.pixelconfig;

import java.io.BufferedReader;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** Flags file parsing and Gservices key/prefix matching for FlagsProvider. No Android types, so
 * hosttest/FlagsQueryTest runs it on the host JVM. */
final class FlagsQuery {
    private FlagsQuery() {}

    static Map<String, String> parse(BufferedReader reader) throws IOException {
        TreeMap<String, String> loaded = new TreeMap<>();
        String line;
        while ((line = reader.readLine()) != null) {
            line = line.trim();
            if (line.isEmpty() || line.startsWith("#")) continue;
            int split = line.indexOf(' ');
            if (split <= 0 || loaded.size() >= 512) throw new IllegalStateException("Invalid vendor flags");
            String key = line.substring(0, split);
            if (!key.startsWith("euicc.") && !key.startsWith("euiccpixel.")) throw new IllegalStateException("Unexpected vendor flag namespace");
            if (loaded.put(key, line.substring(split + 1)) != null) throw new IllegalStateException("Duplicate vendor flag");
        }
        return Collections.unmodifiableMap(loaded);
    }

    static boolean supportedPath(String path) {
        return path.isEmpty() || "/".equals(path) || "/prefix".equals(path);
    }

    /** Rows for a key query (first argument, exact) or a prefix query (any argument), in key order. */
    static List<String[]> select(Map<String, String> flags, String path, String[] args) {
        List<String[]> rows = new ArrayList<>();
        if (args == null || args.length == 0) return rows;
        if (args.length > 64) throw new IllegalArgumentException("Too many flag prefixes");
        boolean prefix = "/prefix".equals(path);
        for (Map.Entry<String, String> row : flags.entrySet()) {
            boolean matches = !prefix && row.getKey().equals(args[0]);
            if (prefix) for (String arg : args) if (arg != null && row.getKey().startsWith(arg)) { matches = true; break; }
            if (matches) rows.add(new String[]{row.getKey(), row.getValue()});
        }
        return rows;
    }
}
