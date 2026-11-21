// spec/os/android/files/storage.md, "Story: Change files only as reviewed"; spec/os/android/files/handoff.md, "Story: Open or share a file without granting write"; spec/os/android/files/storageWatch.md, "Story: Watch a folder with one live observer"
package ai.eliza.plugins.filesystem;

import ai.eliza.plugins.filesystem.browser.StorageBrowser;
import ai.eliza.plugins.filesystem.browser.StorageCatalog;
import android.app.Activity;
import android.app.KeyguardManager;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.ContentObserver;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Environment;
import android.os.FileObserver;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.FileNotFoundException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

@CapacitorPlugin(name = "ElizaFiles", permissions = {
    @Permission(alias = "legacyStorage", strings = {
        android.Manifest.permission.READ_EXTERNAL_STORAGE, android.Manifest.permission.WRITE_EXTERNAL_STORAGE })
})
public class FilesPlugin extends Plugin {
    public interface SelectionRegistry { String authorize(Uri uri, int flags); }

    private enum Review { NONE, ISSUE, CARRIED }
    private record Request(StorageBrowser browser, List<String> selection, List<String> reviewed) {}
    private interface Work { JSObject run(Request request) throws Exception; }

    private static final int SHARE_MAX = 100;
    private static final long BURST_MS = 400, CHOOSER_WAIT_S = 5;
    private static final int WATCH_MASK = FileObserver.CREATE | FileObserver.DELETE | FileObserver.MOVED_FROM
        | FileObserver.MOVED_TO | FileObserver.CLOSE_WRITE | FileObserver.DELETE_SELF | FileObserver.MOVE_SELF;

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final StorageBrowser.WatchSlot watch = new StorageBrowser.WatchSlot();
    private final Handler main = new Handler(Looper.getMainLooper());

    protected String trashFolder() {
        return ".Trash-" + getContext().getPackageName().replaceAll("[^A-Za-z0-9_-]", "-");
    }

    protected SelectionRegistry selections() { return null; }

    private static JSObject result(String status, String message) {
        JSObject out = new JSObject();
        out.put("status", status);
        if (!message.isEmpty()) out.put("message", message);
        return out;
    }

    private JSObject denied() {
        JSObject out = result("denied", StorageCatalog.legacy() ? "Allow storage access to browse files." : "Allow all-files access to browse storage.");
        out.put("access", StorageCatalog.access(getContext()));
        out.put("legacy", StorageCatalog.legacy());
        return out;
    }

    private ContentResolver resolver() { return getContext().getContentResolver(); }

    private void submit(PluginCall call, Runnable work) { submit(call, work, () -> {}); }

    private void submit(PluginCall call, Runnable work, Runnable refused) {
        try {
            worker.execute(work);
        } catch (RejectedExecutionException closed) {
            refused.run();
            call.resolve(result("unavailable", "Files closed."));
        }
    }

    private boolean focused() {
        Activity activity = getActivity();
        KeyguardManager keyguard = getContext().getSystemService(KeyguardManager.class);
        return activity != null && !activity.isFinishing() && !activity.isDestroyed()
            && keyguard != null && !keyguard.isKeyguardLocked() && activity.hasWindowFocus();
    }

    private static List<String> selection(PluginCall call, String key) {
        JSArray array = call.getArray(key);
        if (array == null || array.length() < 1 || array.length() > StorageBrowser.BATCH_MAX) return null;
        List<String> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < array.length(); i++) {
            Object value = array.opt(i);
            if (!(value instanceof String text) || !seen.add(text)) return null;
            out.add(text);
        }
        return out;
    }

    private static List<String> tokens(PluginCall call, List<String> paths) {
        JSArray array = call.getArray("reviewed");
        if (paths == null || array == null || array.length() != paths.size()) return null;
        List<String> out = new ArrayList<>();
        for (int i = 0; i < array.length(); i++) {
            Object value = array.opt(i);
            if (!(value instanceof String token) || !token.matches("[A-Za-z0-9_-]{43}")) return null;
            out.add(token);
        }
        return out;
    }

    private void storage(PluginCall call, Work work) { storage(call, null, Review.NONE, work, () -> {}); }

    private void storage(PluginCall call, String key, Review review, Work work, Runnable refused) {
        submit(call, () -> {
            JSObject out;
            try {
                out = admitted(call, key, review, work);
            } catch (IllegalArgumentException invalid) {
                out = result("invalid", "Invalid name or path.");
            } catch (IllegalStateException clash) {
                out = result("exists", "That name is already used here.");
            } catch (FileNotFoundException gone) {
                out = result("missing", "This item is no longer there.");
            } catch (SecurityException revoked) {
                out = denied();
            } catch (Exception failed) {
                out = result("failed", "The operation could not be confirmed.");
            }
            if (!out.has("status")) out.put("status", "ready");
            if (!"ready".equals(out.getString("status"))) refused.run();
            call.resolve(out);
        }, refused);
    }

    private JSObject admitted(PluginCall call, String key, Review review, Work work) throws Exception {
        boolean carried = review == Review.CARRIED && call.getData().has("reviewed");
        boolean focus = review == Review.ISSUE || carried;
        StorageCatalog.Volume volume = StorageCatalog.volume(getContext(), call.getString("volume", "primary"));
        if (volume == null) return result("unavailable", "This storage is not mounted.");
        List<String> chosen = key == null ? List.of() : selection(call, key);
        List<String> reviewed = carried ? tokens(call, chosen) : null;
        boolean valid = chosen != null && (!carried || reviewed != null);
        if (focus && !focused()) return valid ? result("changed", "Open Files to review these items.") : result("invalid", "Invalid selection.");
        if (!"granted".equals(StorageCatalog.access(getContext()))) return denied();
        if (!valid) return result("invalid", "Invalid selection.");
        return work.run(new Request(new StorageBrowser(volume.directory, trashFolder()), chosen, reviewed));
    }

    private StorageBrowser primary() {
        StorageCatalog.Volume volume = StorageCatalog.volume(getContext(), "primary");
        return new StorageBrowser(volume == null ? Environment.getExternalStorageDirectory() : volume.directory, trashFolder());
    }

    private static JSObject row(StorageBrowser.Row r) {
        JSObject o = new JSObject();
        o.put("path", r.path);
        o.put("name", r.name);
        o.put("directory", r.directory);
        o.put("mimeType", r.mime);
        o.put("size", r.size);
        o.put("modified", r.modified);
        if (r.directory) o.put("children", r.children);
        return o;
    }

    private static JSObject outcomes(List<StorageBrowser.Outcome> list) {
        JSArray rows = new JSArray();
        for (StorageBrowser.Outcome o : list) {
            JSObject v = new JSObject();
            v.put("path", o.path);
            v.put("status", o.status);
            if (o.to != null) v.put("to", o.to);
            rows.put(v);
        }
        JSObject out = new JSObject();
        out.put("outcomes", rows);
        return out;
    }

    private void scan(StorageBrowser browser, List<String> paths) {
        List<String> files = new ArrayList<>();
        for (String path : paths) if (path != null) files.add(new File(browser.root, path).getAbsolutePath());
        if (!files.isEmpty()) MediaScannerConnection.scanFile(getContext(), files.toArray(new String[0]), null, null);
    }

    private JSObject access() {
        JSObject out = result("ready", "");
        out.put("access", StorageCatalog.access(getContext()));
        out.put("legacy", StorageCatalog.legacy());
        return out;
    }

    @PluginMethod public void storageState(PluginCall call) {
        submit(call, () -> {
            JSObject out = access();
            JSArray volumes = new JSArray();
            if ("granted".equals(out.getString("access")))
                for (StorageCatalog.Volume v : StorageCatalog.volumes(getContext())) volumes.put(StorageCatalog.describe(v));
            out.put("volumes", volumes);
            call.resolve(out);
        });
    }

    @PluginMethod public void storageRequestAccess(PluginCall call) {
        String access = StorageCatalog.access(getContext());
        if ("unsupported".equals(access)) { call.resolve(access()); return; }
        if (getActivity() == null) { call.resolve(result("unavailable", "Open the app to change file access.")); return; }
        if (StorageCatalog.legacy() && !Boolean.TRUE.equals(call.getBoolean("settings")) && !"granted".equals(access)) {
            requestPermissionForAlias("legacyStorage", call, "legacyStorageReturned");
            return;
        }
        Uri app = Uri.parse("package:" + getContext().getPackageName());
        Intent page = StorageCatalog.legacy()
            ? new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, app)
            : new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, app);
        try {
            startActivityForResult(call, page, "storageAccessReturned");
        } catch (RuntimeException missing) {
            try {
                startActivityForResult(call, new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION), "storageAccessReturned");
            } catch (RuntimeException again) {
                call.resolve(result("unavailable", "Android's file access settings are unavailable."));
            }
        }
    }

    @PermissionCallback private void legacyStorageReturned(PluginCall call) { call.resolve(access()); }

    @ActivityCallback private void storageAccessReturned(PluginCall call, ActivityResult response) {
        if (call != null) call.resolve(access());
    }

    @PluginMethod public void storageList(PluginCall call) {
        storage(call, request -> {
            List<StorageBrowser.Row> rows = request.browser().list(call.getString("path", ""));
            JSArray entries = new JSArray();
            for (StorageBrowser.Row r : rows.subList(0, Math.min(rows.size(), StorageBrowser.LIST_MAX))) entries.put(row(r));
            JSObject out = new JSObject();
            out.put("entries", entries);
            out.put("truncated", rows.size() > StorageBrowser.LIST_MAX);
            return out;
        });
    }

    @PluginMethod public void storageCategory(PluginCall call) {
        storage(call, request -> Boolean.TRUE.equals(call.getBoolean("countOnly", false))
            ? StorageCatalog.count(resolver(), primary(), call.getString("category", ""))
            : StorageCatalog.category(resolver(), primary(), call.getString("category", "")));
    }

    @PluginMethod public void storageQuery(PluginCall call) {
        storage(call, request -> {
            Double from = call.getDouble("from"), to = call.getDouble("to");
            long since = from == null ? 0 : from.longValue(), until = to == null ? 0 : to.longValue();
            JSObject out = new JSObject();
            if (Boolean.TRUE.equals(call.getBoolean("folders", false))) {
                JSArray rows = new JSArray();
                for (StorageBrowser.Row r : primary().folders(call.getString("folder", ""), call.getString("text"), since, until, StorageCatalog.QUERY_MAX, StorageBrowser.WALK_MAX)) rows.put(row(r));
                out.put("entries", rows);
            } else {
                out.put("entries", StorageCatalog.query(resolver(), call.getString("text"), call.getString("mimePrefix"),
                    Boolean.TRUE.equals(call.getBoolean("documents", false)), call.getString("folder"), since, until));
            }
            return out;
        });
    }

    @PluginMethod public void storageReviewedIdentities(PluginCall call) {
        storage(call, "paths", Review.ISSUE, request -> {
            JSArray tokens = new JSArray();
            for (String identity : request.browser().reviewedIdentities(request.selection())) {
                if (identity == null) return result("changed", "A file couldn't be verified. Nothing changed.");
                tokens.put(identity);
            }
            JSObject out = new JSObject();
            out.put("reviewed", tokens);
            return out;
        }, () -> {});
    }

    @PluginMethod public void storageTransfer(PluginCall call) {
        storage(call, "paths", Review.CARRIED, request -> {
            boolean copy = Boolean.TRUE.equals(call.getBoolean("copy", false));
            List<StorageBrowser.Outcome> done = request.browser().transfer(request.selection(), call.getString("dest", ""), copy, request.reviewed());
            List<String> touched = new ArrayList<>();
            for (StorageBrowser.Outcome o : done) {
                if (o.to != null) touched.add(o.to);
                if (!copy && "moved".equals(o.status)) touched.add(o.path);
            }
            scan(request.browser(), touched);
            return outcomes(done);
        }, () -> {});
    }

    @PluginMethod public void storageRename(PluginCall call) {
        storage(call, request -> {
            String from = call.getString("path", ""), to = request.browser().rename(from, call.getString("name", ""));
            scan(request.browser(), List.of(from, to));
            JSObject out = new JSObject();
            out.put("path", to);
            return out;
        });
    }

    @PluginMethod public void storageCreateFolder(PluginCall call) {
        storage(call, request -> {
            JSObject out = new JSObject();
            out.put("path", request.browser().createFolder(call.getString("parent", ""), call.getString("name", "")));
            return out;
        });
    }

    @PluginMethod public void storageTrash(PluginCall call) {
        storage(call, "paths", Review.CARRIED, request -> {
            List<StorageBrowser.Outcome> done = request.browser().trash(request.selection(), System.currentTimeMillis(), request.reviewed());
            List<String> gone = new ArrayList<>();
            for (StorageBrowser.Outcome o : done) if ("trashed".equals(o.status)) gone.add(o.path);
            scan(request.browser(), gone);
            return outcomes(done);
        }, () -> {});
    }

    @PluginMethod public void storageTrashList(PluginCall call) {
        storage(call, request -> {
            JSArray items = new JSArray();
            for (StorageBrowser.TrashRow r : request.browser().trashList(System.currentTimeMillis())) {
                JSObject o = new JSObject();
                o.put("id", r.id);
                o.put("name", r.name);
                o.put("origin", r.origin);
                o.put("directory", r.directory);
                o.put("mimeType", r.mime);
                o.put("size", r.size);
                o.put("deletedAt", r.deletedAt);
                items.put(o);
            }
            JSObject out = new JSObject();
            out.put("items", items);
            return out;
        });
    }

    @PluginMethod public void storageRestore(PluginCall call) {
        storage(call, "ids", Review.NONE, request -> {
            List<StorageBrowser.Outcome> done = request.browser().restore(request.selection());
            List<String> back = new ArrayList<>();
            for (StorageBrowser.Outcome o : done) if (o.to != null) back.add(o.to);
            scan(request.browser(), back);
            return outcomes(done);
        }, () -> {});
    }

    @PluginMethod public void storageEmptyTrash(PluginCall call) {
        storage(call, "ids", Review.NONE, request -> {
            if (!Boolean.TRUE.equals(call.getBoolean("confirmed", false)))
                return result("confirmation-required", "Confirm before deleting permanently.");
            JSObject out = new JSObject();
            out.put("count", request.browser().emptyTrash(request.selection()));
            return out;
        }, () -> {});
    }

    private Uri contentUri(File file) {
        return FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".storage", file);
    }

    private File regularFile(StorageBrowser browser, String path) throws Exception {
        File file = browser.resolve(path, false);
        if (!file.isFile()) throw new FileNotFoundException();
        return file;
    }

    private boolean postChooser(Intent intent) throws InterruptedException {
        Activity activity = getActivity();
        if (activity == null) return false;
        AtomicInteger stage = new AtomicInteger();
        CountDownLatch answered = new CountDownLatch(1);
        activity.runOnUiThread(() -> {
            if (!stage.compareAndSet(0, 1)) return;
            try {
                activity.startActivity(intent);
                stage.set(2);
            } catch (RuntimeException refused) {
                stage.set(3);
            } finally {
                answered.countDown();
            }
        });
        if (answered.await(CHOOSER_WAIT_S, TimeUnit.SECONDS)) return stage.get() == 2;
        stage.compareAndSet(0, 4);
        return false;
    }

    @PluginMethod public void storageShare(PluginCall call) {
        storage(call, "paths", Review.NONE, request -> {
            if (request.selection().size() > SHARE_MAX) return result("unsupported", "Select up to " + SHARE_MAX + " files to share.");
            ArrayList<Uri> uris = new ArrayList<>();
            Set<String> types = new HashSet<>();
            for (String path : request.selection()) {
                File file = request.browser().resolve(path, false);
                if (file.isDirectory()) return result("unsupported", "Select files without folders to share.");
                if (!file.isFile()) throw new FileNotFoundException();
                uris.add(contentUri(file));
                types.add(StorageBrowser.mime(file.getName()));
            }
            Intent send = new Intent(uris.size() == 1 ? Intent.ACTION_SEND : Intent.ACTION_SEND_MULTIPLE)
                .setType(types.size() == 1 ? types.iterator().next() : "*/*")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            if (uris.size() == 1) send.putExtra(Intent.EXTRA_STREAM, uris.get(0));
            else send.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
            ClipData clip = ClipData.newRawUri("Files", uris.get(0));
            for (Uri uri : uris.subList(1, uris.size())) clip.addItem(new ClipData.Item(uri));
            send.setClipData(clip);
            if (!postChooser(Intent.createChooser(send, null))) return result("failed", "Sharing could not open.");
            JSObject out = result("opened", "");
            out.put("count", uris.size());
            return out;
        }, () -> {});
    }

    @PluginMethod public void storageOpen(PluginCall call) {
        storage(call, request -> {
            File file = regularFile(request.browser(), call.getString("path", ""));
            Intent view = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(contentUri(file), StorageBrowser.mime(file.getName()))
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            if (!postChooser(Intent.createChooser(view, null))) return result("unsupported", "No app can open this file.");
            JSObject out = result("opened", "");
            out.put("count", 1);
            return out;
        });
    }

    @PluginMethod public void storageSelect(PluginCall call) {
        storage(call, request -> {
            SelectionRegistry registry = selections();
            if (registry == null) return result("unsupported", "This app has no file preview.");
            File file = regularFile(request.browser(), call.getString("path", ""));
            Uri uri = contentUri(file);
            String mime = StorageBrowser.mime(file.getName());
            JSObject out = result("selected", "");
            out.put("action", "files");
            out.put("selectionId", registry.authorize(uri, 0));
            out.put("name", file.getName());
            out.put("mimeType", mime);
            out.put("canRename", false);
            if (mime.startsWith("image/") || mime.startsWith("audio/") || mime.startsWith("video/")) out.put("uri", uri.toString());
            return out;
        });
    }

    private StorageBrowser.WatchSlot.Watch register(long ticket, File folder) {
        Runnable changed = () -> { if (watch.observe(ticket)) notifyListeners("storageChanged", new JSObject()); };
        Runnable burst = () -> { main.removeCallbacks(changed); main.postDelayed(changed, BURST_MS); };
        FileObserver files = folder != null && folder.isDirectory() ? new FileObserver(folder, WATCH_MASK) {
            @Override public void onEvent(int event, String name) { burst.run(); }
        } : null;
        ContentObserver media = new ContentObserver(main) {
            @Override public void onChange(boolean self) { burst.run(); }
        };
        StorageBrowser.WatchSlot.Watch resources = () -> {
            try {
                if (files != null) files.stopWatching();
            } finally {
                try {
                    resolver().unregisterContentObserver(media);
                } finally {
                    main.removeCallbacks(changed);
                }
            }
        };
        try {
            if (files != null) files.startWatching();
            resolver().registerContentObserver(MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL), true, media);
        } catch (RuntimeException failed) {
            try {
                resources.stop();
            } catch (RuntimeException cleanup) {
                failed.addSuppressed(cleanup);
            }
            throw failed;
        }
        return resources;
    }

    @PluginMethod public void storageWatch(PluginCall call) {
        long ticket = watch.request();
        storage(call, null, Review.NONE, request -> {
            String path = call.getString("path"), category = call.getString("category");
            File folder = path != null ? request.browser().resolve(path, true)
                : "downloads".equals(category) ? new File(primary().root, StorageCatalog.DOWNLOAD_FOLDER) : null;
            if (!watch.install(ticket, () -> register(ticket, folder))) return result("superseded", "A newer watch replaced this one.");
            return new JSObject();
        }, () -> watch.refuse(ticket));
    }

    @PluginMethod public void storageUnwatch(PluginCall call) {
        watch.unwatch();
        call.resolve(result("ready", ""));
    }

    @Override protected void handleOnDestroy() {
        watch.unwatch();
        worker.shutdownNow();
    }
}
