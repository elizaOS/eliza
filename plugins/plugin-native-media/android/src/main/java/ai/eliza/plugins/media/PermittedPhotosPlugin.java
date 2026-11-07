package ai.eliza.plugins.media;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/**
 * The read-only Photos bridge: library access, permitted listings and reads with bounded previews,
 * and share of one permitted item through Android's share sheet. It owns the permitted catalog and
 * nothing else: no edits, captures, albums, trash, favorites, playback or WebView client, so a host
 * that only shows the library answers no media names.
 *
 * <p>A host subclass declares {@code @CapacitorPlugin(name = ..., permissions = ...)} with the
 * aliases {@link PhotoLibraryAccess#aliases} names for its {@link #libraryProfile()}. Access is
 * requested only from {@link #requestLibraryAccess}; list and read never prompt. Every read holds
 * the catalog's ticket and is published only while it is still current. {@link PhotosPlugin} adds
 * the media management on top of this bridge.
 */
public abstract class PermittedPhotosPlugin extends Plugin {
  /**
   * Fixed answer for a request that reached a destroyed activity. It names no cause as certain and
   * claims nothing about work the request would have led to.
   */
  public static final String CLOSED =
      "Android could not show this request; the app may have closed. Reopen it and try again.";

  /** QA markers are a closed enum: never media data or exception text. See {@link #diagnostic}. */
  public enum Diagnostic {
    READ_INVOKED,
    READ_SUCCEEDED,
    READ_FAILED_SECURITY,
    READ_FAILED_ARGUMENT,
    READ_FAILED_IO,
    READ_FAILED_OTHER,
    LIBRARY_CHANGED_RESUME,
    LIBRARY_CHANGED_CATALOG;

    /** The failure category of a read; the exception's message is never part of it. */
    public static Diagnostic readFailure(Exception failure) {
      return failure instanceof SecurityException            ? READ_FAILED_SECURITY
          : failure instanceof IllegalArgumentException      ? READ_FAILED_ARGUMENT
          : failure instanceof java.io.IOException           ? READ_FAILED_IO
                                                             : READ_FAILED_OTHER;
    }
  }

  /**
   * Which part of the device library this host reads. The default reads photos and videos; a host
   * that shows only still photos returns {@link PhotoLibraryAccess.Profile#IMAGES}.
   */
  protected PhotoLibraryAccess.Profile libraryProfile() {
    return PhotoLibraryAccess.Profile.LIBRARY;
  }

  /** A debug QA marker. Hosts may log it in debug builds; the default records nothing. */
  protected void diagnostic(Diagnostic marker) {}

  /** The answer for a request made after the activity is gone. */
  protected String closedMessage() {
    return CLOSED;
  }

  private PermittedMediaCatalog permitted;
  private volatile boolean destroyed;
  private final ExecutorService worker = Executors.newSingleThreadExecutor();

  /** Runs a launcher-backed request; a launcher that is already gone rejects instead of throwing. */
  protected final boolean ask(PluginCall call, Runnable launch) {
    try {
      launch.run();
      return true;
    } catch (IllegalStateException closed) {
      call.reject(closedMessage());
      return false;
    }
  }

  /** Whether the activity is destroyed; queued work then answers instead of running. */
  protected final boolean destroyed() {
    return destroyed;
  }

  /** The single worker every library call runs on, in order. */
  protected final ExecutorService worker() {
    return worker;
  }

  /** Runs {@code action} on the worker, or rejects when the library is closed. */
  protected final void submit(PluginCall call, Runnable action) {
    if (destroyed) {
      call.reject("Photo library closed");
      return;
    }
    try {
      worker.execute(() -> {
        if (destroyed) call.reject("Photo library closed");
        else action.run();
      });
    } catch (RejectedExecutionException stopped) {
      call.reject("Photo library closed");
    }
  }

  /**
   * A host plugin must declare every library alias so {@link PhotoLibraryAccess#permissionAliases}
   * can name the right ones on any API level. Shared with {@link DeviceLibraryPlugin}.
   */
  static void requireLibraryAliases(Plugin plugin) {
    requireLibraryAliases(plugin, PhotoLibraryAccess.Profile.LIBRARY);
  }

  static void requireLibraryAliases(Plugin plugin, PhotoLibraryAccess.Profile profile) {
    CapacitorPlugin annotation = plugin.getClass().getAnnotation(CapacitorPlugin.class);
    Set<String> declared = new HashSet<>();
    if (annotation != null)
      for (Permission permission : annotation.permissions()) declared.add(permission.alias());
    if (!declared.containsAll(PhotoLibraryAccess.aliases(profile)))
      throw new IllegalStateException(
          "Photos host plugin must declare permission aliases " + PhotoLibraryAccess.aliases(profile));
  }

  @Override
  public void load() {
    PhotoLibraryAccess.Profile profile = libraryProfile();
    requireLibraryAliases(this, profile);
    // Observation starts only while the Photos grid is open (watchLibrary).
    permitted = new PermittedMediaCatalog(getContext(), false, () -> {
      if (!destroyed) {
        diagnostic(Diagnostic.LIBRARY_CHANGED_CATALOG);
        notifyListeners("libraryChanged", new JSObject());
      }
    }, profile);
  }

  /** The single permitted-media catalog shared with the agent album: one index, one epoch. */
  public PermittedMediaCatalog permittedCatalog() {
    return permitted;
  }

  @PluginMethod
  public void libraryAccess(PluginCall call) {
    call.resolve(permitted.access());
  }

  /** Photos grid enter/leave. The agent album watches the same catalog under its own name. */
  @PluginMethod
  public void watchLibrary(PluginCall call) {
    boolean active = call.getBoolean("active", false) && !destroyed;
    permitted.watch("photos", active);
    JSObject out = new JSObject();
    out.put("active", active);
    call.resolve(out);
  }

  @PluginMethod
  public void openLibrarySettings(PluginCall call) {
    if (destroyed || !getActivity().hasWindowFocus()) {
      call.reject("Return to Photos to review access");
      return;
    }
    try {
      getActivity().startActivity(new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
          Uri.fromParts("package", getContext().getPackageName(), null)));
      call.resolve();
    } catch (RuntimeException unavailable) {
      call.reject("Android app settings could not open");
    }
  }

  /** The aliases an explicit access request names on this device for the full library. */
  public static String[] libraryPermissionAliases() {
    return PhotoLibraryAccess.permissionAliases(Build.VERSION.SDK_INT);
  }

  /**
   * Only the explicit Photos permission control invokes this, never list/read/resume. When the
   * profile has nothing to ask on this device, it answers the current access without a prompt.
   */
  @PluginMethod
  public void requestLibraryAccess(PluginCall call) {
    if (destroyed || !getActivity().hasWindowFocus()) {
      call.reject("Return to Photos to choose access");
      return;
    }
    String[] aliases = PhotoLibraryAccess.permissionAliases(Build.VERSION.SDK_INT, libraryProfile());
    if (aliases.length == 0) {
      libraryAccess(call);
      return;
    }
    ask(call, () -> requestPermissionForAliases(aliases, call, "libraryPermissionResult"));
  }

  @PermissionCallback
  private void libraryPermissionResult(PluginCall call) {
    permitted.invalidate();
    libraryAccess(call);
  }

  @Override
  @PluginMethod
  public void requestPermissions(PluginCall call) {
    requestLibraryAccess(call);
  }

  private interface ReadAction {
    JSObject run() throws Exception;
  }

  private void submitRead(PluginCall call, ReadAction action) {
    try {
      long ticket = permitted.readTicket();
      submit(call, () -> {
        try {
          permitted.requireReadTicket(ticket);
          JSObject value = action.run();
          permitted.publish(call, value, ticket);
        } catch (Exception changed) {
          call.reject("Photo library changed or is unavailable. Refresh Photos and check its access.");
        }
      });
    } catch (Exception unavailable) {
      call.reject("Unlock and reopen Photos before reading the library.");
    }
  }

  @PluginMethod
  public void listPermitted(PluginCall call) {
    submitRead(call, () -> permitted.list(call.getString("before", ""), call.getString("query", ""),
        call.getString("kind", "all"), call.getBoolean("thumbnails", true), call.getString("filter", "all")));
  }

  /** {@code edge} bounds the preview: 64 to 2048 pixels, 1024 by default. */
  @PluginMethod
  public void readPermitted(PluginCall call) {
    submitRead(call, () -> permitted.read(call.getString("id"), call.getString("revision"),
        call.getBoolean("pixels", true), false, call.getInt("edge", 1024)));
  }

  /** Android's share sheet for one permitted item at the revision the person saw. */
  @PluginMethod
  public void share(PluginCall call) {
    submit(call, () -> {
      try {
        call.resolve(SelectedDocuments.shareUri(getActivity(), permittedShareUri(call)));
      } catch (Exception failure) {
        call.reject("This saved media is no longer available");
      }
    });
  }

  /** The content URI of the permitted item {@code call} names, checked against its revision. */
  protected final Uri permittedShareUri(PluginCall call) throws Exception {
    String key = call.getString("id", "");
    if (!PhotoLibraryAccess.permitted(key)) throw new IllegalArgumentException();
    String revision = call.getString("revision");
    if (revision == null || revision.isEmpty()) throw new IllegalArgumentException();
    permitted.read(key, revision, false);
    return permitted.uri(MediaLibraryKey.parse(key));
  }

  @Override
  protected void handleOnPause() {
    if (permitted != null) {
      permitted.watch("photos", false);
      permitted.foreground(false);
    }
  }

  @Override
  protected void handleOnResume() {
    if (permitted != null) permitted.foreground(true);
    diagnostic(Diagnostic.LIBRARY_CHANGED_RESUME);
    notifyListeners("libraryChanged", new JSObject());
  }

  /** Closes a subclass's engines after the library is marked closed and before the catalog. */
  protected void closeEngines() {}

  @Override
  protected void handleOnDestroy() {
    destroyed = true;
    closeEngines();
    if (permitted != null) permitted.close();
    worker.shutdown();
  }
}
