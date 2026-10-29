package ai.eliza.plugins.media;

import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/**
 * The Photos bridge: permission-filtered library reads and explicitly reviewed media management
 * over this module's engines. The permitted catalog (full, partial or Android 14 selected scope),
 * its native review, the host's owned library and custom albums, still-photo and video edit
 * copies, explicit capture keeps and same-origin video playback are bound to Capacitor here, so a
 * host only registers a subclass under its own plugin name and installed media names.
 *
 * <p>A host subclass declares {@code @CapacitorPlugin(name = ..., permissions = ...)} with the four
 * aliases in {@link PhotoLibraryAccess#ALIASES} and answers {@link #mediaConfig()} and
 * {@link #playbackPath()}. Access is requested only from {@link #requestLibraryAccess}; list, read
 * and resume never prompt. Every read holds the catalog's ticket and is published only while it is
 * still current. {@code pixels}/{@code thumbnails} choose bounded previews; the original bytes
 * never cross the bridge except through the explicit share and playback grants. Pausing the
 * activity cancels running video copies, stops observation and marks the catalog background;
 * destroying it closes every engine and answers queued calls. Changes to other apps' media (trash,
 * favorite, permanent removal) go through the native review, never a URI-only request.
 */
public abstract class PhotosPlugin extends Plugin {
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

  /** The host's installed media names: preference files, MediaStore folders and name prefixes. */
  protected abstract OwnedMediaConfig mediaConfig();

  /** The same-origin path prefix of video playback grants, for example {@code /_myapp_owned_video/}. */
  protected abstract String playbackPath();

  /** A debug QA marker. Hosts may log it in debug builds; the default records nothing. */
  protected void diagnostic(Diagnostic marker) {}

  /** The answer for a request made after the activity is gone. */
  protected String closedMessage() {
    return CLOSED;
  }

  /** The shared album write gate; instrumentation tests hold it to stall real album writers. */
  public static final Object ALBUMS_LOCK = OwnedAlbums.LOCK;

  private PermittedMediaCatalog permitted;
  private PermittedMediaReview mediaReview;
  private OwnedVideoPlayback playback;
  private OwnedPhotoEdits edits;
  private VideoCopyEdits videoCopies;
  private OwnedCaptures captures;
  private OwnedMediaLibrary owned;
  private OwnedAlbums albums;
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

  private void submit(PluginCall call, Runnable action) {
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
    CapacitorPlugin annotation = plugin.getClass().getAnnotation(CapacitorPlugin.class);
    Set<String> declared = new HashSet<>();
    if (annotation != null)
      for (Permission permission : annotation.permissions()) declared.add(permission.alias());
    if (!declared.containsAll(PhotoLibraryAccess.ALIASES))
      throw new IllegalStateException("Photos host plugin must declare permission aliases " + PhotoLibraryAccess.ALIASES);
  }

  @Override
  public void load() {
    requireLibraryAliases(this);
    // Observation starts only while the Photos grid is open (watchLibrary). Playback grants recheck
    // their item's revision on every byte request, so unrelated media writes do not revoke them.
    OwnedMediaConfig config = mediaConfig();
    permitted = new PermittedMediaCatalog(getContext(), false, () -> {
      if (!destroyed) {
        diagnostic(Diagnostic.LIBRARY_CHANGED_CATALOG);
        notifyListeners("libraryChanged", new JSObject());
      }
    });
    mediaReview = new PermittedMediaReview(getBridge(), permitted, worker, this::ask);
    edits = new OwnedPhotoEdits(getContext(), config, new OwnedPhotoEdits.SourceAccess() {
      @Override
      public boolean accepts(String id) {
        return PhotoLibraryAccess.permitted(id);
      }
      @Override
      public Uri source(String id) throws Exception {
        revision(id);
        return permitted.uri(MediaLibraryKey.parse(id));
      }
      @Override
      public String revision(String id) throws Exception {
        MediaLibraryKey key = MediaLibraryKey.parse(id);
        if (key.video) throw new IllegalArgumentException("Only still photos support edit copies");
        JSObject item = permitted.read(id, null, false);
        if (item.getLong("size") > 32L * 1024 * 1024)
          throw new IllegalArgumentException("Edit copies support source files up to 32 MB");
        return item.getString("mutationRevision");
      }
    });
    captures = new OwnedCaptures(getContext(), config);
    playback = new OwnedVideoPlayback(getBridge(), playbackPath());
    owned = new OwnedMediaLibrary(getContext(), config, playback::revoke);
    albums = new OwnedAlbums(getContext(), config, owned, permitted);
    getBridge().setWebViewClient(playback);
  }

  /** The single permitted-media catalog shared with the agent album: one index, one epoch. */
  public PermittedMediaCatalog permittedCatalog() {
    return permitted;
  }

  /** The single permitted-media review shared with the agent album: one review at a time. */
  public PermittedMediaReview permittedReview() {
    return mediaReview;
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

  /** The aliases an explicit access request names on this device. */
  public static String[] libraryPermissionAliases() {
    return PhotoLibraryAccess.permissionAliases(Build.VERSION.SDK_INT);
  }

  /** Only the explicit Photos permission control invokes this, never list/read/resume. */
  @PluginMethod
  public void requestLibraryAccess(PluginCall call) {
    if (destroyed || !getActivity().hasWindowFocus()) {
      call.reject("Return to Photos to choose access");
      return;
    }
    String[] aliases = libraryPermissionAliases();
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

  @PluginMethod
  public void readPermitted(PluginCall call) {
    submitRead(call, () -> permitted.read(call.getString("id"), call.getString("revision"),
        call.getBoolean("pixels", true)));
  }

  @Override
  protected void handleOnPause() {
    if (videoCopies != null) videoCopies.cancel(null);
    if (permitted != null) {
      permitted.watch("photos", false);
      permitted.foreground(false);
    }
    if (playback != null) playback.clear();
  }

  @Override
  protected void handleOnResume() {
    if (permitted != null) permitted.foreground(true);
    diagnostic(Diagnostic.LIBRARY_CHANGED_RESUME);
    notifyListeners("libraryChanged", new JSObject());
  }

  @PluginMethod
  public void beginEdit(PluginCall call) {
    submit(call, () -> {
      try {
        call.resolve(edits.begin(call.getString("id"), call.getString("revision")));
      } catch (Exception e) {
        call.reject(e.getMessage() == null ? "Photo editor unavailable" : e.getMessage());
      }
    });
  }

  @PluginMethod
  public void previewEdit(PluginCall call) {
    submit(call, () -> {
      try {
        call.resolve(edits.preview(call.getString("sessionId"), call.getInt("rotation", 0),
            call.getBoolean("crop", false), call.getString("filter", "none")));
      } catch (Exception e) {
        call.reject(e.getMessage() == null ? "Preview unavailable" : e.getMessage());
      }
    });
  }

  @PluginMethod
  public void saveEdit(PluginCall call) {
    submit(call, () -> {
      try {
        call.resolve(edits.save(call.getString("sessionId"), call.getInt("rotation", 0),
            call.getBoolean("crop", false), call.getString("filter", "none")));
      } catch (Exception e) {
        call.reject(e.getMessage() == null ? "Save outcome unknown; inspect Photos before retrying" : e.getMessage());
      }
    });
  }

  @PluginMethod
  public void editResult(PluginCall call) {
    if (VideoCopyEdits.isVideoOperation(call.getString("operationId"))) {
      try {
        videoCopies().result(call.getString("operationId"), call);
      } catch (Exception unavailable) {
        call.reject("Saved-copy outcome could not be confirmed");
      }
      return;
    }
    submit(call, () -> {
      try {
        call.resolve(edits.result(call.getString("operationId")));
      } catch (Exception e) {
        call.reject("Saved-copy outcome could not be confirmed");
      }
    });
  }

  @PluginMethod
  public void cancelEdit(PluginCall call) {
    edits.cancel(call.getString("sessionId"));
    submit(call, () -> {
      edits.releaseCancelled();
      call.resolve();
    });
  }

  private synchronized VideoCopyEdits videoCopies() throws java.io.IOException {
    if (destroyed) throw new java.io.IOException("Photo library closed");
    if (videoCopies == null)
      videoCopies = new VideoCopyEdits(getContext(), mediaConfig(), new VideoCopyEdits.Sources() {
        @Override
        public VideoCopyEdits.Source read(String key, String expected) throws Exception {
          return videoSource(key, expected, true);
        }
        @Override
        public VideoCopyEdits.Source recheck(String key, String expected) throws Exception {
          return videoSource(key, expected, false);
        }
      }, () -> !destroyed && getActivity() != null && getActivity().hasWindowFocus());
    return videoCopies;
  }

  /**
   * Native-only reviewed recovery of a closed failed video copy; deliberately absent from the
   * Capacitor API. Hosts expose it to their own native review path only.
   */
  protected final void preserveClosedFailure(String operationId, String expectedRecordHash, PluginCall call) {
    if (destroyed || getActivity() == null || !getActivity().hasWindowFocus()) {
      call.reject("Video copy preservation refused");
      return;
    }
    try {
      videoCopies().preserveClosedFailure(operationId, expectedRecordHash, call);
    } catch (Exception refused) {
      call.reject("Video copy preservation refused");
    }
  }

  /**
   * The renderer supplies an existing catalog identity/revision, never a URI or file path.
   * {@code opening}: an editor is being opened, so Photos must have window focus. Later rechecks
   * keep every identity, access and revision check but not focus, so a shade pulled down mid-export
   * keeps the export.
   */
  private VideoCopyEdits.Source videoSource(String key, String expected, boolean opening) throws Exception {
    if (destroyed || getActivity() == null || opening && !getActivity().hasWindowFocus() || expected == null)
      throw new IllegalStateException("Return to Photos and reopen the video");
    JSObject record;
    Uri source;
    if (PhotoLibraryAccess.permitted(key)) {
      MediaLibraryKey media = MediaLibraryKey.parse(key);
      if (!media.video) throw new IllegalArgumentException("Choose a video");
      record = permitted.read(key, null, false, false);
      source = permitted.uri(media);
    } else {
      if (!OwnedMediaLibrary.isOwnedKey(key) || !OwnedMediaLibrary.video(key))
        throw new IllegalArgumentException("Choose a video");
      record = owned.metadata(key, false);
      source = OwnedMediaLibrary.uri(key);
    }
    String revision = record.getString("mutationRevision");
    if (!expected.equals(revision)) throw new IllegalArgumentException("Video changed. Close and reopen the editor.");
    return new VideoCopyEdits.Source(source, revision);
  }

  @PluginMethod
  public void beginVideoEdit(PluginCall call) {
    try {
      videoCopies().begin(call.getString("id"), call.getString("revision"), call);
    } catch (Exception unavailable) {
      call.reject("Video editor is unavailable. Original unchanged.");
    }
  }

  @PluginMethod
  public void saveVideoEdit(PluginCall call) {
    try {
      videoCopies().save(call.getString("sessionId"), call.getDouble("start", Double.NaN),
          call.getDouble("end", Double.NaN), call.getInt("rotation", -1), call.getBoolean("crop", false), call);
    } catch (Exception unavailable) {
      call.reject("Video edit could not start. Original unchanged.");
    }
  }

  @PluginMethod
  public void cancelVideoEdit(PluginCall call) {
    if (videoCopies != null) videoCopies.cancel(call.getString("sessionId"));
    call.resolve();
  }

  @PluginMethod
  public void list(PluginCall call) {
    submit(call, () -> {
      try {
        boolean trashed = call.getBoolean("trashed", false);
        if (trashed && Build.VERSION.SDK_INT < PhotoLibraryAccess.TRASH_SDK) {
          call.reject("Android trash requires Android 11 or later");
          return;
        }
        String album = call.getString("album", "");
        if (PhotoLibraryAccess.customAlbum(album)) {
          call.resolve(albums.list(album.substring(7), call.getString("before", "")));
          return;
        }
        String[] listing = PhotoLibraryAccess.permittedListing(album, trashed);
        if (PhotoLibraryAccess.readable(permitted.access())) {
          call.resolve(permitted.list(call.getString("before", ""), "", listing[0], true, listing[1]));
          return;
        }
        if (album.equals("favorites") && Build.VERSION.SDK_INT < PhotoLibraryAccess.TRASH_SDK) {
          call.reject("Favorites require Android 11 or later");
          return;
        }
        call.resolve(owned.list(call.getString("before", ""), trashed, album));
      } catch (Exception failure) {
        call.reject("Saved media could not be loaded");
      }
    });
  }

  @PluginMethod
  public void read(PluginCall call) {
    diagnostic(Diagnostic.READ_INVOKED);
    submit(call, () -> {
      try {
        boolean trashed = Boolean.TRUE.equals(call.getBoolean("includeTrashed", false));
        String key = call.getString("id", "");
        if (PhotoLibraryAccess.permitted(key)) {
          JSObject result = permitted.read(key, call.getString("revision"), true, trashed);
          MediaLibraryKey media = MediaLibraryKey.parse(key);
          String revision = result.getString("revision");
          if (media.video)
            result.put("path", playback.authorize(permitted.uri(media), () -> {
              try {
                permitted.read(key, revision, false, trashed);
              } catch (Exception unavailable) {
                throw new SecurityException("Selected video changed or is unavailable");
              }
            }));
          call.resolve(result);
          diagnostic(Diagnostic.READ_SUCCEEDED);
          return;
        }
        JSObject result = owned.read(key, trashed);
        if (OwnedMediaLibrary.video(key)) result.put("path", playback.authorize(OwnedMediaLibrary.uri(key)));
        call.resolve(result);
        diagnostic(Diagnostic.READ_SUCCEEDED);
      } catch (Exception failure) {
        diagnostic(Diagnostic.readFailure(failure));
        call.reject("This saved media is no longer available");
      }
    });
  }

  /**
   * Scan mode captures stay in memory. Keep photo is the only path that publishes one to Photos:
   * exact JPEG bytes, pending until fully written, one result per operation.
   */
  @PluginMethod
  public void keepCapture(PluginCall call) {
    submit(call, () -> {
      try {
        OwnedCaptures.Result result = captures.keep(call.getString("operationId", ""), call.getString("dataBase64", ""));
        JSObject out = new JSObject();
        out.put("status", result.saved ? "saved" : "failed");
        if (result.id != null) out.put("id", result.id);
        if (result.message != null) out.put("message", result.message);
        call.resolve(out);
      } catch (IllegalArgumentException invalid) {
        call.reject("Invalid keep request");
      }
    });
  }

  @PluginMethod
  public void share(PluginCall call) {
    submit(call, () -> {
      try {
        String key = call.getString("id", "");
        if (PhotoLibraryAccess.permitted(key)) {
          String revision = call.getString("revision");
          if (revision == null || revision.isEmpty()) throw new IllegalArgumentException();
          permitted.read(key, revision, false);
          call.resolve(SelectedDocuments.shareUri(getActivity(), permitted.uri(MediaLibraryKey.parse(key))));
          return;
        }
        call.resolve(SelectedDocuments.shareUri(getActivity(), owned.verified(key, null)));
      } catch (Exception failure) {
        call.reject("This saved media is no longer available");
      }
    });
  }

  @PluginMethod
  public void shareMany(PluginCall call) {
    submit(call, () -> {
      try {
        JSArray items = call.getArray("items");
        if (items == null || items.length() < 1 || items.length() > OwnedMediaLibrary.BATCH)
          throw new IllegalArgumentException();
        ArrayList<Uri> uris = new ArrayList<>();
        Set<String> unique = new HashSet<>();
        for (int i = 0; i < items.length(); i++) {
          org.json.JSONObject item = items.getJSONObject(i);
          String key = item.getString("id");
          if (!unique.add(key)) throw new IllegalArgumentException();
          if (PhotoLibraryAccess.permitted(key)) {
            String revision = item.getString("revision");
            if (revision.isEmpty()) throw new IllegalArgumentException();
            permitted.read(key, revision, false);
            uris.add(permitted.uri(MediaLibraryKey.parse(key)));
          } else uris.add(owned.verified(key, item.getString("revision")));
        }
        String mime = OwnedMediaLibrary.shareType(getContext().getContentResolver(), uris);
        Intent send = new Intent(Intent.ACTION_SEND_MULTIPLE).setType(mime)
            .putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        ClipData clip = ClipData.newRawUri("Selected media", uris.get(0));
        for (int i = 1; i < uris.size(); i++) clip.addItem(new ClipData.Item(uris.get(i)));
        send.setClipData(clip);
        getActivity().runOnUiThread(() -> {
          if (destroyed || getActivity().isFinishing() || !getActivity().hasWindowFocus()) {
            call.reject("Return to Photos and share the selection again");
            return;
          }
          try {
            getActivity().startActivity(Intent.createChooser(send, "Share selected media"));
            JSObject result = new JSObject();
            result.put("status", "opened");
            result.put("count", uris.size());
            call.resolve(result);
          } catch (RuntimeException failure) {
            call.reject("Android sharing could not open");
          }
        });
      } catch (Exception failure) {
        call.reject("A selected item changed or is unavailable. Reselect the media before sharing.");
      }
    });
  }

  @PluginMethod
  public void setTrashed(PluginCall call) {
    setFlag(call, false);
  }

  @PluginMethod
  public void setFavorite(PluginCall call) {
    setFlag(call, true);
  }

  private void setFlag(PluginCall call, boolean favorite) {
    submit(call, () -> {
      try {
        Boolean desired = call.getBoolean(favorite ? "favorite" : "trashed");
        if (desired == null) throw new IllegalArgumentException();
        String key = call.getString("id", "");
        if (PhotoLibraryAccess.permitted(key)) {
          mediaReview.request(call, List.of(key), List.of(call.getString("revision")), favorite, desired, false);
          return;
        }
        call.resolve(owned.changeFlag(call.getString("id"), call.getString("revision"), favorite, desired));
      } catch (Exception failure) {
        call.reject("This media changed or could not be verified. Refresh Photos before trying again.");
      }
    });
  }

  @PluginMethod
  public void deletePermittedTrash(PluginCall call) {
    submit(call, () -> {
      try {
        List<PhotoLibraryAccess.Reviewed> items = PhotoLibraryAccess.reviewed(call.getArray("items"), PhotoLibraryAccess.REVIEWED);
        for (PhotoLibraryAccess.Reviewed item : items) MediaLibraryKey.parse(item.id);
        mediaReview.deleteTrashed(call, PhotoLibraryAccess.ids(items), PhotoLibraryAccess.revisions(items));
      } catch (Exception invalid) {
        call.reject("Select 1–20 unchanged deleted items again.");
      }
    });
  }

  /** A bounded partial operation, never an atomic all-or-nothing promise. */
  @PluginMethod
  public void changeMany(PluginCall call) {
    submit(call, () -> {
      try {
        String operation = call.getString("operation", "");
        boolean[] change = PhotoLibraryAccess.batchChange(operation);
        JSArray items = call.getArray("items");
        List<PhotoLibraryAccess.Reviewed> reviewed = PhotoLibraryAccess.reviewed(items, PhotoLibraryAccess.REVIEWED);
        if (PhotoLibraryAccess.anyPermitted(reviewed)) {
          mediaReview.request(call, PhotoLibraryAccess.ids(reviewed), PhotoLibraryAccess.revisions(reviewed),
              change[0], change[1], true);
          return;
        }
        call.resolve(owned.changeMany(operation, items, () -> destroyed));
      } catch (Exception invalid) {
        call.reject("Select 1–20 distinct owned items with current revisions.");
      }
    });
  }

  @PluginMethod
  public void summary(PluginCall call) {
    submit(call, () -> {
      try {
        if (PhotoLibraryAccess.readable(permitted.access())) {
          call.resolve(permitted.summary());
          return;
        }
        call.resolve(owned.summary());
      } catch (Exception failure) {
        call.reject("Album counts could not be loaded");
      }
    });
  }

  @PluginMethod
  public void prepareDeleteTrash(PluginCall call) {
    submit(call, () -> {
      if (Build.VERSION.SDK_INT < PhotoLibraryAccess.TRASH_SDK) {
        call.reject("Android trash requires Android 11 or later");
        return;
      }
      // Emptying the trash is only the explicit {all:true} intent; a missing, null or non-list
      // items value is refused, never read as every trashed item.
      TrashDeleteRequest request;
      try {
        request = TrashDeleteRequest.fromPayload(call.getData());
      } catch (IllegalArgumentException unusable) {
        call.reject("Select deleted items again. The selection was not a list of items.");
        return;
      }
      try {
        call.resolve(owned.prepareDeleteTrash(request));
      } catch (OwnedMediaLibrary.TooManyTrashed tooMany) {
        call.reject("More than 500 owned items are in trash. Manage a smaller batch in Android Photos.");
      } catch (Exception failure) {
        call.reject("Trash could not be prepared for confirmation");
      }
    });
  }

  @PluginMethod
  public void cancelDeleteTrash(PluginCall call) {
    submit(call, () -> {
      owned.cancelDeleteTrash(call.getString("confirmation", ""));
      call.resolve();
    });
  }

  @PluginMethod
  public void deletePreparedTrash(PluginCall call) {
    submit(call, () -> {
      if (Build.VERSION.SDK_INT < PhotoLibraryAccess.TRASH_SDK) {
        call.reject("Android trash requires Android 11 or later");
        return;
      }
      try {
        call.resolve(owned.deletePreparedTrash(call.getString("confirmation", ""), () -> destroyed));
      } catch (IllegalStateException expired) {
        call.reject("Delete confirmation expired. Review trash again.");
      }
    });
  }

  @PluginMethod
  public void albums(PluginCall call) {
    submit(call, () -> {
      if (Build.VERSION.SDK_INT < PhotoLibraryAccess.TRASH_SDK) {
        call.reject("Owned albums require Android 11 or later");
        return;
      }
      try {
        call.resolve(albums.albums());
      } catch (Exception failure) {
        call.reject("Owned albums could not be loaded");
      }
    });
  }

  @PluginMethod
  public void changeAlbum(PluginCall call) {
    submit(call, () -> {
      if (Build.VERSION.SDK_INT < PhotoLibraryAccess.TRASH_SDK) {
        call.reject("Owned albums require Android 11 or later");
        return;
      }
      if (destroyed) {
        call.reject("Photo library closed");
        return;
      }
      try {
        call.resolve(albums.change(call.getString("operation", ""), call.getString("id", ""),
            call.getString("revision"), call.getString("name"), call.getString("mediaId", ""),
            call.getString("mediaRevision"), () -> destroyed));
      } catch (IllegalArgumentException failure) {
        call.reject(failure.getMessage());
      } catch (Exception failure) {
        call.reject("Album could not be saved. Reload albums before trying again");
      }
    });
  }

  @Override
  protected void handleOnDestroy() {
    destroyed = true;
    if (videoCopies != null) videoCopies.close();
    if (mediaReview != null) mediaReview.close();
    if (permitted != null) permitted.close();
    if (edits != null) edits.cancel(null);
    try {
      worker.execute(() -> {
        if (edits != null) edits.close();
      });
    } catch (RejectedExecutionException stopped) {
      // Already stopped: nothing left to close on it.
    }
    worker.shutdown();
    if (playback != null) playback.clear();
  }
}
