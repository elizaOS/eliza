package ai.eliza.plugins.media;

import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.RejectedExecutionException;

/**
 * The Photos bridge: permission-filtered library reads and explicitly reviewed media management
 * over this module's engines. The permitted catalog (full, partial or Android 14 selected scope),
 * its native review, the host's owned library and custom albums, still-photo and video edit
 * copies, explicit capture keeps and same-origin video playback are bound to Capacitor here, so a
 * host only registers a subclass under its own plugin name and installed media names.
 *
 * <p>The library access, permitted reads and share come from {@link PermittedPhotosPlugin}. A host
 * subclass declares {@code @CapacitorPlugin(name = ..., permissions = ...)} with the four aliases
 * in {@link PhotoLibraryAccess#ALIASES} and answers {@link #mediaConfig()} and
 * {@link #playbackPath()}. Access is requested only from {@link #requestLibraryAccess}; list, read
 * and resume never prompt. Every read holds the catalog's ticket and is published only while it is
 * still current. {@code pixels}/{@code thumbnails} choose bounded previews; the original bytes
 * never cross the bridge except through the explicit share and playback grants. Pausing the
 * activity cancels running video copies, stops observation and marks the catalog background;
 * destroying it closes every engine and answers queued calls. Changes to other apps' media (trash,
 * favorite, permanent removal) go through the native review, never a URI-only request.
 */
public abstract class PhotosPlugin extends PermittedPhotosPlugin {
  /** The host's installed media names: preference files, MediaStore folders and name prefixes. */
  protected abstract OwnedMediaConfig mediaConfig();

  /** The same-origin path prefix of video playback grants, for example {@code /_myapp_owned_video/}. */
  protected abstract String playbackPath();

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

  @Override
  public void load() {
    super.load();
    // Playback grants recheck their item's revision on every byte request, so unrelated media
    // writes do not revoke them.
    OwnedMediaConfig config = mediaConfig();
    permitted = permittedCatalog();
    mediaReview = new PermittedMediaReview(getBridge(), permitted, worker(), this::ask);
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

  /** The single permitted-media review shared with the agent album: one review at a time. */
  public PermittedMediaReview permittedReview() {
    return mediaReview;
  }

  @Override
  protected void handleOnPause() {
    if (videoCopies != null) videoCopies.cancel(null);
    super.handleOnPause();
    if (playback != null) playback.clear();
  }

  @PluginMethod
  public void beginEdit(PluginCall call) {
    submitRead(call, () -> {
      try {
        return edits.begin(call.getString("id"), call.getString("revision"));
      } catch (Exception e) {
        call.reject(e.getMessage() == null ? "Photo editor unavailable" : e.getMessage());
        return null;
      }
    });
  }

  @PluginMethod
  public void previewEdit(PluginCall call) {
    submitRead(call, () -> {
      try {
        return edits.preview(call.getString("sessionId"), call.getInt("rotation", 0),
            call.getBoolean("crop", false), call.getString("filter", "none"));
      } catch (Exception e) {
        call.reject(e.getMessage() == null ? "Preview unavailable" : e.getMessage());
        return null;
      }
    });
  }

  /**
   * Saves the edit as a new copy, or with {@code replace: true} (offered when {@code beginEdit}
   * answered {@code canReplace}) over the reviewed original. Replacing another app's photo first
   * asks Android's write consent; the write then rechecks the reviewed revision.
   */
  @PluginMethod
  public void saveEdit(PluginCall call) {
    boolean replace = Boolean.TRUE.equals(call.getBoolean("replace", false));
    submit(call, () -> {
      try {
        String token = call.getString("sessionId");
        int rotation = call.getInt("rotation", 0);
        boolean crop = call.getBoolean("crop", false);
        String filter = call.getString("filter", "none");
        if (!replace) {
          call.resolve(edits.save(token, rotation, crop, filter));
          return;
        }
        String[] consent = edits.replaceConsent(token);
        if (consent == null) {
          call.resolve(replaceEdit(token, rotation, crop, filter));
          return;
        }
        mediaReview.requestWrite(call, consent[0], consent[1], () -> {
          try {
            call.resolve(replaceEdit(token, rotation, crop, filter));
          } catch (Exception e) {
            call.reject(e.getMessage() == null
                ? "Replace outcome unknown; inspect Photos before retrying" : e.getMessage());
          }
        });
      } catch (Exception e) {
        call.reject(e.getMessage() == null ? "Save outcome unknown; inspect Photos before retrying" : e.getMessage());
      }
    });
  }

  private JSObject replaceEdit(String token, int rotation, boolean crop, String filter)
      throws Exception {
    JSObject receipt = edits.replace(token, rotation, crop, filter);
    // A replaced original has new bytes: open pages and read tickets of the old ones end here.
    if ("saved".equals(receipt.getString("status"))) permitted.invalidate();
    return receipt;
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
    if (destroyed()) throw new java.io.IOException("Photo library closed");
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
      }, () -> !destroyed() && getActivity() != null && getActivity().hasWindowFocus());
    return videoCopies;
  }

  /**
   * Native-only reviewed recovery of a closed failed video copy; deliberately absent from the
   * Capacitor API. Hosts expose it to their own native review path only.
   */
  protected final void preserveClosedFailure(String operationId, String expectedRecordHash, PluginCall call) {
    if (destroyed() || getActivity() == null || !getActivity().hasWindowFocus()) {
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
    if (destroyed() || getActivity() == null || opening && !getActivity().hasWindowFocus() || expected == null)
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
    submitRead(call, () -> {
      try {
        boolean trashed = call.getBoolean("trashed", false);
        if (trashed && Build.VERSION.SDK_INT < PhotoLibraryAccess.TRASH_SDK) {
          call.reject("Android trash requires Android 11 or later");
          return null;
        }
        String album = call.getString("album", "");
        if (PhotoLibraryAccess.customAlbum(album))
          return albums.list(album.substring(7), call.getString("before", ""));
        // A caller that needs fewer rows (Camera's last-capture tile reads one) asks for a smaller page.
        int limit = Math.max(1, Math.min(OwnedMediaLibrary.PAGE, call.getInt("limit", OwnedMediaLibrary.PAGE)));
        boolean thumbnails = call.getBoolean("thumbnails", true);
        String[] listing = PhotoLibraryAccess.permittedListing(album, trashed);
        if (PhotoLibraryAccess.readable(permitted.access()))
          return permitted.list(call.getString("before", ""), "", listing[0], thumbnails, listing[1],
              0, Long.MAX_VALUE, limit);
        if (album.equals("favorites") && Build.VERSION.SDK_INT < PhotoLibraryAccess.TRASH_SDK) {
          call.reject("Favorites require Android 11 or later");
          return null;
        }
        return owned.list(call.getString("before", ""), trashed, album, limit, thumbnails);
      } catch (Exception failure) {
        call.reject("Saved media could not be loaded");
        return null;
      }
    });
  }

  /** Reload bounded grid thumbnails through the same profile and publication guards as reads. */
  @PluginMethod
  public void thumbnails(PluginCall call) {
    submitRead(call, () -> {
      try {
        JSArray ids = call.getArray("ids");
        if (ids == null || ids.length() < 1 || ids.length() > OwnedMediaLibrary.PAGE)
          throw new IllegalArgumentException();
        JSArray items = new JSArray();
        for (int i = 0; i < ids.length(); i++) {
          String id = ids.getString(i);
          JSObject item = new JSObject();
          item.put("id", id);
          try {
            item.put("image", PhotoLibraryAccess.permitted(id)
                ? permitted.read(id, null, true, false, 240).getString("image")
                : owned.preview(id, 240));
          } catch (Exception unavailable) {
            item.put("image", "");
          }
          items.put(item);
        }
        JSObject result = new JSObject();
        result.put("items", items);
        return result;
      } catch (Exception invalid) {
        call.reject("Select 1-" + OwnedMediaLibrary.PAGE + " listed items.");
        return null;
      }
    });
  }

  @PluginMethod
  public void read(PluginCall call) {
    diagnostic(Diagnostic.READ_INVOKED);
    submitRead(call, () -> {
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
          return result;
        }
        JSObject result = owned.read(key, trashed);
        if (OwnedMediaLibrary.video(key)) result.put("path", playback.authorize(OwnedMediaLibrary.uri(key)));
        return result;
      } catch (Exception failure) {
        diagnostic(Diagnostic.readFailure(failure));
        call.reject("This saved media is no longer available");
        return null;
      }
    }, () -> diagnostic(Diagnostic.READ_SUCCEEDED));
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

  /** Shares one permitted item or one item of the host's owned library. */
  @Override
  @PluginMethod
  public void share(PluginCall call) {
    submit(call, () -> {
      try {
        String key = call.getString("id", "");
        if (PhotoLibraryAccess.permitted(key)) {
          call.resolve(SelectedDocuments.shareUri(getActivity(), permittedShareUri(call)));
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
        if (items == null || items.length() < 1 || items.length() > PhotoLibraryAccess.SHARE)
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
          if (destroyed() || getActivity().isFinishing() || !getActivity().hasWindowFocus()) {
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
        // The owned library retains its own 20-item bound; permitted changes share one review.
        List<PhotoLibraryAccess.Reviewed> reviewed = PhotoLibraryAccess.reviewed(items, PhotoLibraryAccess.REVIEWED_BATCH);
        if (PhotoLibraryAccess.anyPermitted(reviewed)) {
          mediaReview.request(call, PhotoLibraryAccess.ids(reviewed), PhotoLibraryAccess.revisions(reviewed),
              change[0], change[1], true);
          return;
        }
        call.resolve(owned.changeMany(operation, items, () -> destroyed()));
      } catch (Exception invalid) {
        call.reject("Select 1–20 distinct owned items with current revisions.");
      }
    });
  }

  @PluginMethod
  public void summary(PluginCall call) {
    submitRead(call, () -> {
      try {
        return PhotoLibraryAccess.readable(permitted.access()) ? permitted.summary() : owned.summary();
      } catch (Exception failure) {
        call.reject("Album counts could not be loaded");
        return null;
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
        call.resolve(owned.deletePreparedTrash(call.getString("confirmation", ""), () -> destroyed()));
      } catch (IllegalStateException expired) {
        call.reject("Delete confirmation expired. Review trash again.");
      }
    });
  }

  @PluginMethod
  public void albums(PluginCall call) {
    submitRead(call, () -> {
      if (Build.VERSION.SDK_INT < PhotoLibraryAccess.TRASH_SDK) {
        call.reject("Owned albums require Android 11 or later");
        return null;
      }
      try {
        return albums.albums();
      } catch (Exception failure) {
        call.reject("Owned albums could not be loaded");
        return null;
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
      if (destroyed()) {
        call.reject("Photo library closed");
        return;
      }
      try {
        call.resolve(albums.change(call.getString("operation", ""), call.getString("id", ""),
            call.getString("revision"), call.getString("name"), call.getString("mediaId", ""),
            call.getString("mediaRevision"), () -> destroyed()));
      } catch (IllegalArgumentException failure) {
        call.reject(failure.getMessage());
      } catch (Exception failure) {
        call.reject("Album could not be saved. Reload albums before trying again");
      }
    });
  }

  @Override
  protected void closeEngines() {
    if (videoCopies != null) videoCopies.close();
    if (mediaReview != null) mediaReview.close();
    if (edits != null) edits.cancel(null);
    try {
      worker().execute(() -> {
        if (edits != null) edits.close();
      });
    } catch (RejectedExecutionException stopped) {
      // Already stopped: nothing left to close on it.
    }
    if (playback != null) playback.clear();
  }
}
