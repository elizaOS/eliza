package ai.elizaresearch.pixelconfig;

import android.app.Instrumentation;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;

/** Opt-in on-device integration probe; never included in the system application. */
public final class ProviderProbe extends Instrumentation {
    @Override public void onCreate(Bundle args) { super.onCreate(args); start(); }
    private static void require(boolean condition) { if (!condition) throw new AssertionError("Vendor configuration contract failed"); }
    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            var resolver = getTargetContext().getContentResolver();
            Uri base = Uri.parse("content://com.google.android.gsf.gservices");
            String key = "euiccpixel.experiment.Ota__should_enable_esim_gc_recovery";
            try (Cursor cursor = resolver.query(base, null, null, new String[]{key}, null)) {
                require(cursor != null && cursor.getCount() == 1 && cursor.moveToFirst());
                require("key".equals(cursor.getColumnName(0)) && "value".equals(cursor.getColumnName(1)));
                require(key.equals(cursor.getString(0)) && "true".equals(cursor.getString(1)));
            }
            try (Cursor cursor = resolver.query(Uri.withAppendedPath(base, "prefix"), null, null, new String[]{"euicc.", "euiccpixel."}, null)) {
                require(cursor != null && cursor.getCount() == 2);
            }
            try (Cursor cursor = resolver.query(base, null, null, new String[]{"unknown.flag"}, null)) { require(cursor != null && cursor.getCount() == 0); }
            try { resolver.insert(base, new ContentValues()); throw new AssertionError("Write accepted"); } catch (UnsupportedOperationException expected) {}
            try { resolver.update(base, new ContentValues(), null, null); throw new AssertionError("Write accepted"); } catch (UnsupportedOperationException expected) {}
            try { resolver.delete(base, null, null); throw new AssertionError("Write accepted"); } catch (UnsupportedOperationException expected) {}
            result.putString("stream", "PASS: real provider key/prefix reads, absent key, and rejected writes\n");
            finish(-1, result);
        } catch (Throwable error) {
            result.putString("stream", "FAIL: " + error + "\n");
            finish(1, result);
        }
    }
}
