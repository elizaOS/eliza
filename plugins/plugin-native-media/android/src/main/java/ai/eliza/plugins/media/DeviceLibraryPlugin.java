package ai.eliza.plugins.media;

import android.app.KeyguardManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.UserManager;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginHandle;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The agent's album facade over the same permission and exact-revision catalog as Photos. It uses
 * the host's {@link PhotosPlugin} catalog and review (one epoch, one observer, one review at a
 * time), owns no index and never uses URI-only destructive requests. Pages are bounded and carry
 * no thumbnails unless asked; {@code inspect} chooses preview pixels; {@code validate} rechecks up to
 * 200 named rows under one fence. Changes are favorite, unfavorite and Recently deleted, each
 * through the native review; permanent deletion stays in the system photos app.
 *
 * <p>A host subclass declares {@code @CapacitorPlugin(name = ..., permissions = ...)} with the four
 * aliases in {@link PhotoLibraryAccess#ALIASES} (Capacitor queues permission calls by originating
 * plugin, so this facade owns its callback) and names its Photos plugin in
 * {@link #photosPluginName()}, which must load first.
 */
public abstract class DeviceLibraryPlugin extends Plugin {
  /** The host's registered {@link PhotosPlugin} name. */
  protected abstract String photosPluginName();

  /** The answer for a request made after the activity is gone. */
  protected String closedMessage() {
    return PhotosPlugin.CLOSED;
  }

  private final ExecutorService worker = Executors.newSingleThreadExecutor();
  private PermittedMediaCatalog catalog;
  private PermittedMediaReview review;
  private volatile boolean destroyed, watching;

  private PhotosPlugin photos() {
    PluginHandle handle = getBridge().getPlugin(photosPluginName());
    if (handle == null || !(handle.getInstance() instanceof PhotosPlugin))
      throw new IllegalStateException(photosPluginName() + " must be a registered PhotosPlugin");
    return (PhotosPlugin) handle.getInstance();
  }

  @Override
  public void load() {
    PhotosPlugin.requireLibraryAliases(this);
    PhotosPlugin photos = photos();
    catalog = photos.permittedCatalog();
    review = photos.permittedReview();
    if (catalog == null || review == null)
      throw new IllegalStateException(photosPluginName() + " must load before the device library");
    catalog.addListener(() -> {
      if (watching && !destroyed) notifyListeners("libraryChanged", new JSObject());
    });
  }

  private interface ReadAction {
    void run(long ticket);
  }

  private void submit(PluginCall call, ReadAction action) {
    if (destroyed) {
      call.reject("Device library closed");
      return;
    }
    try {
      long ticket = catalog.readTicket();
      worker.execute(() -> {
        try {
          catalog.requireReadTicket(ticket);
          if (destroyed) throw new IllegalStateException();
          action.run(ticket);
        } catch (Exception changed) {
          call.reject("Device library access changed");
        }
      });
    } catch (RuntimeException stopped) {
      // Includes RejectedExecutionException from a stopped worker.
      call.reject("Device library closed");
    }
  }

  private boolean locked() {
    KeyguardManager keyguard = getContext().getSystemService(KeyguardManager.class);
    UserManager users = getContext().getSystemService(UserManager.class);
    return keyguard == null || users == null || keyguard.isDeviceLocked() || !users.isUserUnlocked();
  }

  private JSObject scopeResult() {
    String version;
    try {
      version = catalog.fence().cursorIdentity();
    } catch (Exception unavailable) {
      version = "";
    }
    JSObject out = new JSObject();
    try {
      PhotoLibraryAccess.scope(catalog.access(), Build.VERSION.SDK_INT, locked(), version, out);
    } catch (org.json.JSONException impossible) {
      throw new IllegalStateException(impossible);
    }
    return out;
  }

  private boolean readable(PluginCall call) {
    if (locked()) {
      call.reject("Unlock the phone to use the device library", "LIBRARY_LOCKED");
      return false;
    }
    if (!PhotoLibraryAccess.readable(catalog.access())) {
      call.reject("Photo library access is not allowed", "LIBRARY_DENIED");
      return false;
    }
    return true;
  }

  @PluginMethod
  public void scope(PluginCall call) {
    call.resolve(scopeResult());
  }

  @PluginMethod
  public void requestAccess(PluginCall call) {
    if (destroyed || getActivity() == null || !getActivity().hasWindowFocus()) {
      call.reject("Return to Photos to choose access");
      return;
    }
    String[] aliases = PhotosPlugin.libraryPermissionAliases();
    try {
      requestPermissionForAliases(aliases, call, "libraryPermissionResult");
    } catch (IllegalStateException closed) {
      call.reject(closedMessage());
    }
  }

  @PermissionCallback
  private void libraryPermissionResult(PluginCall call) {
    if (destroyed) {
      call.reject("Device library closed");
      return;
    }
    catalog.invalidate();
    call.resolve(scopeResult());
  }

  @Override
  @PluginMethod
  public void requestPermissions(PluginCall call) {
    requestAccess(call);
  }

  @PluginMethod
  public void watch(PluginCall call) {
    watching = call.getBoolean("active", false) && !destroyed;
    catalog.watch("library", watching);
    JSObject out = new JSObject();
    out.put("active", watching);
    call.resolve(out);
  }

  private JSObject item(JSObject row) {
    row.put("takenAt", row.optLong("date", 0L));
    return row;
  }

  @PluginMethod
  public void page(PluginCall call) {
    submit(call, ticket -> {
      if (!readable(call)) return;
      try {
        JSObject page = catalog.list(call.getString("before", ""), call.getString("query", ""),
            call.getString("kind", "all"), call.getBoolean("thumbnails", false),
            call.getBoolean("favorites", false) ? "favorites" : "all", call.getLong("from", 0L),
            call.getLong("to", Long.MAX_VALUE), PhotoLibraryAccess.pageLimit(call.getInt("limit", PhotoLibraryAccess.PAGE)));
        JSArray rows = new JSArray();
        org.json.JSONArray source = page.getJSONArray("items");
        for (int i = 0; i < source.length(); i++)
          rows.put(item(JSObject.fromJSONObject(source.getJSONObject(i))));
        JSObject out = scopeResult();
        out.put("items", rows);
        out.put("next", page.getString("next"));
        out.put("generation", 1);
        catalog.publish(call, out, ticket);
      } catch (Exception failure) {
        call.reject("Photo library changed. Reload before continuing.");
      }
    });
  }

  @PluginMethod
  public void inspect(PluginCall call) {
    submit(call, ticket -> {
      if (!readable(call)) return;
      try {
        catalog.publish(call, item(catalog.read(call.getString("id"), null, call.getBoolean("pixels", true))), ticket);
      } catch (Exception failure) {
        call.reject("That item is unavailable", "LIBRARY_MISSING");
      }
    });
  }

  @PluginMethod
  public void validate(PluginCall call) {
    submit(call, ticket -> {
      if (!readable(call)) return;
      try {
        JSArray requested = call.getArray("items"), results = new JSArray();
        if (requested == null || requested.length() > PhotoLibraryAccess.VALIDATE)
          throw new IllegalArgumentException();
        PermittedMediaCatalog.Fence fence = catalog.fence();
        for (int i = 0; i < requested.length(); i++) {
          org.json.JSONObject expected = requested.getJSONObject(i);
          String id = expected.getString("id");
          JSObject result = new JSObject();
          result.put("id", id);
          try {
            JSObject row = item(catalog.read(id, null, false));
            boolean same = row.getString("revision").equals(expected.getString("revision"));
            result.put("status", same ? "current" : "changed");
            if (!same) result.put("item", row);
          } catch (SecurityException missing) {
            result.put("status", "missing");
          }
          results.put(result);
        }
        catalog.requireCurrent(fence);
        JSObject out = new JSObject();
        out.put("items", results);
        catalog.publish(call, out, ticket);
      } catch (Exception unavailable) {
        call.reject("Library validation unavailable. Reload Photos.");
      }
    });
  }

  /** A full bounded page refresh avoids a second unqualified incremental index. */
  @PluginMethod
  public void changes(PluginCall call) {
    JSObject out = new JSObject();
    out.put("reset", true);
    call.resolve(out);
  }

  @PluginMethod
  public void requestChange(PluginCall call) {
    submit(call, ticket -> {
      if (!readable(call)) return;
      try {
        boolean[] change = PhotoLibraryAccess.agentChange(call.getString("operation", ""));
        if (change == null) {
          call.reject("Manage permanent deletion in Android Photos.");
          return;
        }
        List<PhotoLibraryAccess.Reviewed> items =
            PhotoLibraryAccess.reviewed(call.getArray("items"), PhotoLibraryAccess.REVIEWED);
        review.request(call, PhotoLibraryAccess.ids(items), PhotoLibraryAccess.revisions(items), change[0], change[1], true);
      } catch (Exception unavailable) {
        call.reject("Select current permitted items before review.");
      }
    });
  }

  @PluginMethod
  public void share(PluginCall call) {
    photos().shareMany(call);
  }

  // Foreground state and closing belong to the Photos plugin, which owns the catalog and review.
  @Override
  protected void handleOnPause() {
    watching = false;
    if (catalog != null) catalog.watch("library", false);
  }

  // Posted so the Photos plugin's own handleOnResume (plugin order is unspecified) has restored
  // foreground first.
  @Override
  protected void handleOnResume() {
    new Handler(Looper.getMainLooper()).post(() -> {
      if (!destroyed) notifyListeners("scopeChanged", scopeResult());
    });
  }

  @Override
  protected void handleOnDestroy() {
    destroyed = true;
    watching = false;
    if (catalog != null) catalog.watch("library", false);
    worker.shutdown();
  }
}
