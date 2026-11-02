package ai.elizaos.updater;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;

/**
 * The updater's status for the launcher: `call("status")` returns state (up-to-date, downloading or
 * ready, unset before the first check) and version. State only, never a failure.
 */
public final class StatusProvider extends ContentProvider {
    @Override public boolean onCreate() {
        return true;
    }

    @Override public Bundle call(String method, String arg, Bundle extras) {
        getContext().enforceCallingPermission("ai.elizaos.updater.permission.READ_STATUS", "Updater status permission required");
        if (!"status".equals(method)) throw new IllegalArgumentException("Unknown method");
        SharedPreferences store = UpdateJob.store(getContext());
        Bundle status = new Bundle();
        status.putString(UpdateJob.STATE, store.getString(UpdateJob.STATE, null));
        status.putString(UpdateJob.VERSION, store.getString(UpdateJob.VERSION, null));
        return status;
    }

    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String order) {
        return null;
    }

    @Override public String getType(Uri uri) {
        return null;
    }

    @Override public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException();
    }

    @Override public int delete(Uri uri, String selection, String[] args) {
        throw new UnsupportedOperationException();
    }

    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) {
        throw new UnsupportedOperationException();
    }
}
