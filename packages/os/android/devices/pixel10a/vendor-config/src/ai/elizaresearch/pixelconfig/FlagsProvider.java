package ai.elizaresearch.pixelconfig;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.Binder;
import android.os.Process;
import java.io.BufferedReader;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Map;
import java.util.TreeMap;

/** Read-only extracted eSIM configuration for Alpha's AOSP image without GSF.
 * Gservices key/prefix cursor protocol: GrapheneOS GmsCompat GservicesProvider,
 * tag 2026100600. No accounts, network, mutable flags, or Google service APIs.
 */
public final class FlagsProvider extends ContentProvider {
    private static final String AUTHORITY = "com.google.android.gsf.gservices";
    private static final String[] CLIENTS = {"com.google.euiccpixel", "com.google.android.euicc"};
    private Map<String, String> flags;

    @Override public boolean onCreate() {
        File file = new File("/system_ext/etc/gmscompat/gservices-flags/flags.txt");
        TreeMap<String, String> loaded = new TreeMap<>();
        try {
            if (!file.isFile() || file.length() > 1024 * 1024) throw new IllegalStateException("Missing or oversized vendor flags");
            try (BufferedReader reader = Files.newBufferedReader(file.toPath(), StandardCharsets.UTF_8)) {
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
            }
        } catch (Exception error) {
            throw new IllegalStateException("Cannot load extracted Pixel eSIM configuration", error);
        }
        flags = java.util.Collections.unmodifiableMap(loaded);
        return true;
    }

    private void enforceCaller() {
        int uid = Binder.getCallingUid();
        if (uid == Process.SYSTEM_UID || uid == Process.myUid()) return;
        PackageManager pm = getContext().getPackageManager();
        for (String name : CLIENTS) {
            try {
                ApplicationInfo app = pm.getApplicationInfo(name, 0);
                if (app.uid == uid && (app.flags & ApplicationInfo.FLAG_SYSTEM) != 0) return;
            } catch (PackageManager.NameNotFoundException absent) { /* No client installed. */ }
        }
        throw new SecurityException("Only installed system eSIM clients may read vendor flags");
    }

    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String order) {
        enforceCaller();
        if (!AUTHORITY.equals(uri.getAuthority()) || !(uri.getPath().isEmpty() || "/".equals(uri.getPath()) || "/prefix".equals(uri.getPath()))) throw new IllegalArgumentException("Unsupported flags URI");
        MatrixCursor cursor = new MatrixCursor(new String[]{"key", "value"});
        if (args == null || args.length == 0) return cursor;
        if (args.length > 64) throw new IllegalArgumentException("Too many flag prefixes");
        boolean prefix = "/prefix".equals(uri.getPath());
        for (Map.Entry<String, String> row : flags.entrySet()) {
            boolean matches = !prefix && row.getKey().equals(args[0]);
            if (prefix) for (String arg : args) if (arg != null && row.getKey().startsWith(arg)) { matches = true; break; }
            if (matches) cursor.addRow(new Object[]{row.getKey(), row.getValue()});
        }
        return cursor;
    }
    @Override public String getType(Uri uri) { enforceCaller(); return "vnd.android.cursor.dir/vnd.alpha.pixel-flags"; }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException("Read-only vendor configuration"); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException("Read-only vendor configuration"); }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException("Read-only vendor configuration"); }
}
