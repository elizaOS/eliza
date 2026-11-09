package ai.eliza.plugins.media;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import android.os.ParcelFileDescriptor;
import android.os.Process;
import android.os.RemoteException;
import android.os.SharedMemory;
import android.os.SystemClock;
import com.getcapacitor.JSObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.Predicate;
import java.util.regex.Pattern;

/**
 * Opaque capabilities for documents the owner selected in Android's picker. Every call names a
 * random selection ID, resolved again on each use; a URI from the renderer is never accepted. The
 * renderer does receive the document's content URI, which a host may pass to Capacitor's
 * convertFileSrc for previews or scan import; it reads only through this app's existing grant, so
 * grants and selection IDs remain the authority boundary. Only grants Android
 * actually offered are persisted; a revoked grant is forgotten and reported, never repaired. A
 * persisted grant that a saved item's source link still names (see {@link SourceReferences}) is
 * kept when its selection is forgotten or evicted. The registry is device-local and never sent to
 * a signed-in agent account. One instance per host process; the host supplies its installed
 * preference name and private preview file prefix.
 */
public final class SelectedDocuments {
  private static final Pattern NAME = Pattern.compile("[a-z][a-z0-9-]{0,63}");
  private static final int MAX_SELECTIONS = 32;
  private static final int MAX_TEXT_BYTES = 64 * 1024;
  private final Map<String, Uri> selected = new LinkedHashMap<>();
  private final Map<String, Integer> retained = new LinkedHashMap<>();
  private final Context owner;
  private final String preferences;
  private final String previewPrefix;
  private final Predicate<String> referenced;
  private final Class<? extends IsolatedPdfRenderService> pdfRenderer;
  private final Handler main = new Handler(Looper.getMainLooper());
  // One PDF preview at a time; never the registry monitor, so other calls proceed during a render.
  private final Object rendering = new Object();
  // Guards the renderer binding; held only briefly, from the plugin thread and the main thread.
  private final Object binding = new Object();
  private RendererBinding bound;
  private int rendersInFlight;
  private final Runnable idleUnbind = () -> {
    synchronized (binding) {
      if (rendersInFlight == 0)
        unbindRenderer();
    }
  };
  /** Same as the five-argument form with no PDF renderer: PDF previews are refused. */
  public SelectedDocuments(
      Context context, String preferencesName, String previewPrefix, Predicate<String> referenced) {
    this(context, preferencesName, previewPrefix, referenced, null);
  }
  /**
   * {@code preferencesName}: the host's SharedPreferences name for the selection registry.
   * {@code previewPrefix}: the file-name stem of rendered previews in the host's cache directory.
   * {@code referenced}: whether a saved item's source link still names a document URI; such a grant
   * is never released here.
   * {@code pdfRenderer}: the host's isolated PDF renderer component, or null to refuse previews.
   * Selected PDFs are never parsed in this process.
   */
  public SelectedDocuments(Context context, String preferencesName, String previewPrefix,
      Predicate<String> referenced, Class<? extends IsolatedPdfRenderService> pdfRenderer) {
    if (preferencesName == null || !NAME.matcher(preferencesName).matches() || previewPrefix == null
        || !NAME.matcher(previewPrefix).matches())
      throw new IllegalArgumentException("Invalid selected-document storage name");
    owner = context.getApplicationContext();
    preferences = preferencesName;
    this.previewPrefix = previewPrefix;
    this.referenced = referenced == null ? uri -> false : referenced;
    this.pdfRenderer = pdfRenderer;
    try {
      org.json.JSONArray entries = new org.json.JSONArray(
          owner.getSharedPreferences(preferences, 0).getString("records", "[]"));
      for (int i = 0; i < Math.min(entries.length(), MAX_SELECTIONS); i++) {
        org.json.JSONObject entry = entries.getJSONObject(i);
        String id = entry.getString("id");
        Uri uri = Uri.parse(entry.getString("uri"));
        int flags = entry.getInt("flags");
        if (!id.matches("[a-f0-9-]{36}") || !"content".equals(uri.getScheme()) || flags < 1
            || flags > 3)
          continue;
        selected.put(id, uri);
        retained.put(id, flags);
      }
    } catch (Exception ignored) { /* Corrupt registry confers no new access. */
    }
  }
  private void persist() {
    org.json.JSONArray entries = new org.json.JSONArray();
    try {
      for (Map.Entry<String, Integer> entry : retained.entrySet())
        if (selected.containsKey(entry.getKey())) {
          org.json.JSONObject record = new org.json.JSONObject();
          record.put("id", entry.getKey());
          record.put("uri", selected.get(entry.getKey()).toString());
          record.put("flags", entry.getValue());
          entries.put(record);
        }
    } catch (org.json.JSONException error) {
      throw new IllegalStateException(error);
    }
    if (!owner.getSharedPreferences(preferences, 0)
            .edit()
            .putString("records", entries.toString())
            .commit())
      throw new IllegalStateException("Selection could not be saved");
  }
  /** Records one picker result. {@code flags}: the persisted read/write grant taken, or 0. */
  public synchronized String authorize(Uri uri, int flags) {
    if (uri == null || !"content".equals(uri.getScheme()))
      throw new IllegalArgumentException("Picker content URI required");
    String id = UUID.randomUUID().toString();
    if (flags != 0)
      for (Map.Entry<String, Integer> previous : retained.entrySet())
        if (uri.equals(selected.get(previous.getKey())))
          flags |= previous.getValue();
    selected.put(id, uri);
    if (flags != 0)
      retained.put(id, flags);
    try {
      persist();
    } catch (RuntimeException error) {
      selected.remove(id);
      retained.remove(id);
      releaseUnused(uri, flags);
      throw error;
    }
    while (selected.size() > MAX_SELECTIONS) forget(selected.keySet().iterator().next());
    return id;
  }
  public synchronized Uri resolve(String id) {
    Uri uri = id == null ? null : selected.get(id);
    if (uri == null)
      return null;
    if (retained.containsKey(id)) {
      boolean granted = false;
      for (android.content.UriPermission permission :
          owner.getContentResolver().getPersistedUriPermissions())
        if (permission.getUri().equals(uri) && permission.isReadPermission()) {
          granted = true;
          break;
        }
      if (!granted) {
        forget(id);
        return null;
      }
    }
    return uri;
  }
  /** A grant that a saved item's source link still names is kept with the selection's. */
  private boolean referencedBySavedItem(Uri uri) {
    return referenced.test(uri.toString());
  }
  private void releaseUnused(Uri uri, int flags) {
    if (uri == null || flags == 0 || selected.containsValue(uri) || referencedBySavedItem(uri))
      return;
    try {
      owner.getContentResolver().releasePersistableUriPermission(uri, flags);
    } catch (SecurityException ignored) { /* Already revoked by the provider. */
    }
  }
  /**
   * Releases the persisted grant on exactly this document once the last note reference to it is
   * gone and no picker selection holds it. A folder (tree) grant that covers it is never touched.
   */
  public synchronized boolean releaseUnreferenced(Uri uri) {
    Context context = owner;
    if (uri == null || !"content".equals(uri.getScheme()) || selected.containsValue(uri)
        || referencedBySavedItem(uri))
      return false;
    for (android.content.UriPermission grant :
        context.getContentResolver().getPersistedUriPermissions()) {
      if (!grant.getUri().equals(uri))
        continue;
      int flags = (grant.isReadPermission() ? Intent.FLAG_GRANT_READ_URI_PERMISSION : 0)
          | (grant.isWritePermission() ? Intent.FLAG_GRANT_WRITE_URI_PERMISSION : 0);
      try {
        context.getContentResolver().releasePersistableUriPermission(uri, flags);
        return true;
      } catch (SecurityException revoked) {
        return false;
      }
    }
    return false;
  }
  public synchronized void forget(String id) {
    if (id == null)
      return;
    Uri uri = selected.remove(id);
    Integer flags = retained.remove(id);
    try {
      persist();
    } catch (RuntimeException error) {
      if (uri != null)
        selected.put(id, uri);
      if (flags != null)
        retained.put(id, flags);
      throw error;
    }
    releaseUnused(uri, flags == null ? 0 : flags);
    clearPreview(id);
  }
  private void clearPreview(String id) {
    if (id == null || !id.matches("[a-f0-9-]{36}"))
      return;
    new java.io.File(owner.getCacheDir(), previewPrefix + id + ".pdf").delete();
    new java.io.File(owner.getCacheDir(), previewPrefix + id + ".png").delete();
  }
  /** The most recent selection whose grant Android still holds, after forgetting revoked ones. */
  public synchronized JSObject restore() {
    Context context = owner;
    String[] ids = retained.keySet().toArray(new String[0]);
    for (int i = ids.length - 1; i >= 0; i--) {
      String id = ids[i];
      Uri uri = selected.get(id);
      boolean valid = false;
      for (android.content.UriPermission grant :
          context.getContentResolver().getPersistedUriPermissions())
        if (grant.getUri().equals(uri) && grant.isReadPermission()) {
          valid = true;
          break;
        }
      if (!valid) {
        forget(id);
        continue;
      }
      try {
        JSObject value = describe(id);
        value.put("status", "selected");
        value.put("action", "files");
        return value;
      } catch (SecurityException error) {
        forget(id);
      } catch (RuntimeException error) {
        return result("failed",
            "The saved document provider is unavailable. Try again or select another document.");
      }
    }
    return result("unavailable", "No saved document selection");
  }
  /**
   * Reopen one recorded selection by its opaque ID, only while Android still
   * holds its grant. A revoked grant is forgotten and reported, never repaired.
   */
  public synchronized JSObject describeSelected(String id) {
    if (id == null || !id.matches("[a-f0-9-]{36}") || resolve(id) == null)
      return result("unavailable", "Access to this file ended. Select it again.");
    try {
      JSObject value = describe(id);
      value.put("status", "selected");
      value.put("action", "files");
      return value;
    } catch (SecurityException error) {
      forget(id);
      return result("unavailable", "Access to this file ended. Select it again.");
    } catch (RuntimeException error) {
      return result("failed", "The document provider is unavailable. Try again.");
    }
  }
  private JSObject describe(String id) {
    Context context = owner;
    Uri uri = resolve(id);
    if (uri == null)
      throw new IllegalArgumentException();
    JSObject value = new JSObject();
    value.put("selectionId", id);
    value.put("uri", uri.toString());
    value.put("mimeType", context.getContentResolver().getType(uri));
    try (android.database.Cursor cursor = context.getContentResolver().query(
             uri, new String[] {android.provider.OpenableColumns.DISPLAY_NAME}, null, null, null)) {
      if (cursor == null || !cursor.moveToFirst())
        throw new IllegalStateException();
      value.put("name", cursor.getString(0));
    }
    boolean rename = false;
    try (android.database.Cursor cursor = context.getContentResolver().query(uri,
             new String[] {android.provider.DocumentsContract.Document.COLUMN_FLAGS}, null, null,
             null)) {
      if (cursor != null && cursor.moveToFirst())
        rename =
            (cursor.getInt(0) & android.provider.DocumentsContract.Document.FLAG_SUPPORTS_RENAME)
            != 0;
    } catch (RuntimeException ignored) { /* Non-document providers may omit operation flags. */
    }
    value.put("canRename",
        rename && (retained.getOrDefault(id, 0) & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0
            && context.checkUriPermission(uri, android.os.Process.myPid(),
                   android.os.Process.myUid(), Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                == android.content.pm.PackageManager.PERMISSION_GRANTED);
    return value;
  }
  public synchronized JSObject rename(String id, String name) {
    Context context = owner;
    Uri uri = resolve(id);
    if (uri == null)
      return result("unavailable", "Select this document again.");
    if (name == null || name.trim().isEmpty() || name.trim().equals(".") || name.trim().equals("..")
        || name.length() > 255 || name.indexOf('/') >= 0 || name.indexOf('\\') >= 0
        || name.chars().anyMatch(c -> Character.isISOControl(c)))
      return result("failed", "Enter a valid file name.");
    try {
      if (!describe(id).optBoolean("canRename"))
        return result("unsupported",
            "This provider did not grant rename access. Select the file again or rename it in its "
            + "document app.");
      Uri renamed = android.provider.DocumentsContract.renameDocument(
          context.getContentResolver(), uri, name.trim());
      if (renamed == null)
        return result("failed", "The provider did not rename the document.");
      Integer flags = retained.get(id);
      selected.put(id, renamed);
      // Providers may return the same ID after rescanning and revoke its old grant.
      // Reacquire only the permission offered by the returned document; never infer
      // durable access from ownership of the underlying MediaStore file.
      if (flags != null) {
        try {
          context.getContentResolver().takePersistableUriPermission(renamed, flags);
        } catch (SecurityException unavailable) {
          retained.remove(id);
        }
        if (!renamed.equals(uri))
          releaseUnused(uri, flags);
      }
      boolean durable = false;
      for (android.content.UriPermission grant :
          context.getContentResolver().getPersistedUriPermissions())
        if (grant.getUri().equals(renamed) && grant.isReadPermission()) {
          durable = true;
          break;
        }
      if (!durable) {
        forget(id);
        JSObject value = result("renamed-reselect",
            "The provider completed the rename but did not retain access. Select the renamed file "
            + "to verify it and continue.");
        value.put("action", "files");
        return value;
      }
      clearPreview(id);
      persist();
      JSObject value = describe(id);
      value.put("status", "selected");
      value.put("action", "files");
      return value;
    } catch (SecurityException error) {
      forget(id);
      return result("unavailable", "Access expired. Select this document again.");
    } catch (Exception error) {
      return result("failed",
          "The provider could not confirm the rename. Refresh or reselect before retrying.");
    }
  }
  /**
   * Renders one page of a selected PDF to a private PNG preview. The page is parsed only by the
   * host's isolated renderer, from a read-only copy; this process maps the returned pixels after
   * {@link PdfPageLimits#requireReply} accepts the reply. The registry monitor is held only to
   * resolve the selection. Call from a plugin worker thread, never the main thread.
   */
  public JSObject pdf(String id, int pageIndex) {
    if (Looper.myLooper() == Looper.getMainLooper())
      throw new IllegalStateException("PDF preview waits for its renderer");
    Context context = owner;
    Uri uri = resolve(id);
    if (uri == null)
      return result("unavailable", "Select this document again.");
    if (pdfRenderer == null)
      return result(
          "unsupported", "PDF preview is unavailable here. Open it in Android to view it.");
    synchronized (rendering) {
      java.io.File copy = new java.io.File(context.getCacheDir(), previewPrefix + id + ".pdf"),
                   image = new java.io.File(context.getCacheDir(), previewPrefix + id + ".png");
      try {
        if (!"application/pdf".equals(context.getContentResolver().getType(uri)))
          return result("unsupported", "This selection is not a PDF.");
        try (InputStream in = context.getContentResolver().openInputStream(uri);
            java.io.FileOutputStream out = new java.io.FileOutputStream(copy)) {
          if (in == null)
            throw new IOException();
          byte[] buffer = new byte[8192];
          long total = 0;
          int count;
          while ((count = in.read(buffer)) != -1) {
            if (count > PdfPageLimits.MAX_SELECTED_SOURCE_BYTES - total)
              throw new IOException();
            out.write(buffer, 0, count);
            total += count;
          }
          PdfPageLimits.requireSource(total, PdfPageLimits.MAX_SELECTED_SOURCE_BYTES);
        }
        Bundle reply;
        try (ParcelFileDescriptor descriptor =
                 ParcelFileDescriptor.open(copy, ParcelFileDescriptor.MODE_READ_ONLY)) {
          reply = renderIsolated(descriptor, pageIndex);
        }
        if (reply == null)
          return result("failed", "PDF preview timed out. Try again.");
        int pages = writePreview(reply, pageIndex, image);
        JSObject value = result("rendered", "PDF rendered on this device. Nothing was uploaded.");
        value.put("page", pageIndex);
        value.put("pageCount", pages);
        value.put("imageUri", Uri.fromFile(image).toString());
        return value;
      } catch (SecurityException error) {
        return result("unavailable",
            "This PDF is encrypted or access expired. Open it in a compatible app or select it "
            + "again.");
      } catch (Exception | OutOfMemoryError error) {
        return result("failed",
            "PDF preview is unavailable. It may be malformed, encrypted, or larger than 20 MiB.");
      } finally {
        copy.delete();
      }
    }
  }
  /** Checks the renderer's reply, then writes its pixels to {@code image}; returns the pages. */
  private static int writePreview(Bundle reply, int pageIndex, java.io.File image)
      throws IOException {
    SharedMemory pixels = null;
    ByteBuffer mapped = null;
    android.graphics.Bitmap bitmap = null;
    try {
      Object raw = reply.getParcelable("pixels");
      if (raw != null && !(raw instanceof SharedMemory))
        throw new IllegalArgumentException();
      pixels = (SharedMemory) raw;
      if (reply.containsKey("error") || pixels == null)
        throw new IOException();
      int width = reply.getInt("width"), height = reply.getInt("height"),
          pages = reply.getInt("pages");
      PdfPageLimits.requireReply(reply.getBoolean("isolated"), reply.getBoolean("internetDenied"),
          reply.getInt("uid"), Process.myUid(), width, height, pages, reply.getInt("page"),
          pageIndex, pixels.getSize());
      mapped = pixels.mapReadOnly();
      bitmap = android.graphics.Bitmap.createBitmap(
          width, height, android.graphics.Bitmap.Config.ARGB_8888);
      bitmap.copyPixelsFromBuffer(mapped);
      try (java.io.FileOutputStream out = new java.io.FileOutputStream(image)) {
        if (!bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out))
          throw new IOException();
      }
      return pages;
    } catch (android.system.ErrnoException error) {
      throw new IOException(error);
    } finally {
      if (mapped != null)
        SharedMemory.unmap(mapped);
      if (pixels != null)
        pixels.close();
      if (bitmap != null)
        bitmap.recycle();
    }
  }
  /**
   * Sends one page request to the host's isolated renderer and waits up to
   * {@link PdfPageLimits#VIEWER_TIMEOUT_MS}. Returns the matching reply, or null on timeout. The
   * binding is kept between pages and released after a short idle period or when it breaks.
   */
  private Bundle renderIsolated(ParcelFileDescriptor descriptor, int pageIndex)
      throws InterruptedException, RemoteException {
    long deadline = SystemClock.uptimeMillis() + PdfPageLimits.VIEWER_TIMEOUT_MS;
    RendererBinding renderer;
    synchronized (binding) {
      rendersInFlight++;
      main.removeCallbacks(idleUnbind);
      if (bound == null || bound.broken)
        bindRenderer();
      renderer = bound;
    }
    String request = UUID.randomUUID().toString();
    PendingReply pending = new PendingReply(request);
    boolean healthy = false;
    try {
      if (renderer == null
          || !renderer.connected.await(
              Math.max(0, deadline - SystemClock.uptimeMillis()), TimeUnit.MILLISECONDS)
          || renderer.remote == null)
        return null;
      Bundle data = new Bundle();
      data.putString("request", request);
      data.putInt("page", pageIndex);
      data.putParcelable("descriptor", descriptor);
      data.putBoolean("selected", true);
      Message message = Message.obtain(null, IsolatedPdfRenderService.MESSAGE);
      message.replyTo = new Messenger(new Handler(Looper.getMainLooper(), reply -> {
        pending.offer(reply.getData());
        return true;
      }));
      message.setData(data);
      renderer.remote.send(message);
      Bundle reply = pending.await(Math.max(0, deadline - SystemClock.uptimeMillis()));
      healthy = reply != null && !renderer.broken;
      return reply;
    } finally {
      pending.abandon();
      synchronized (binding) {
        rendersInFlight--;
        if (!healthy && bound == renderer)
          unbindRenderer();
        else if (rendersInFlight == 0)
          main.postDelayed(idleUnbind, RENDERER_IDLE_MS);
      }
    }
  }
  private void bindRenderer() {
    unbindRenderer();
    RendererBinding next = new RendererBinding();
    try {
      if (owner.bindService(new Intent(owner, pdfRenderer), next, Context.BIND_AUTO_CREATE))
        bound = next;
      else
        owner.unbindService(next);
    } catch (RuntimeException unavailable) {
      bound = null;
    }
  }
  private void unbindRenderer() {
    if (bound == null)
      return;
    try {
      owner.unbindService(bound);
    } catch (IllegalArgumentException ignored) {
    }
    bound = null;
  }
  /** Idle time after the last page before the isolated renderer is released. */
  private static final long RENDERER_IDLE_MS = 30000;
  /** One binding to the isolated renderer; callbacks arrive on the main thread. */
  private static final class RendererBinding implements ServiceConnection {
    final CountDownLatch connected = new CountDownLatch(1);
    volatile Messenger remote;
    volatile boolean broken;
    @Override public void onServiceConnected(ComponentName name, IBinder binder) {
      remote = new Messenger(binder);
      connected.countDown();
    }
    @Override public void onServiceDisconnected(ComponentName name) {
      stop();
    }
    @Override public void onBindingDied(ComponentName name) {
      stop();
    }
    @Override public void onNullBinding(ComponentName name) {
      stop();
    }
    private void stop() {
      broken = true;
      remote = null;
      connected.countDown();
    }
  }
  /** The reply to one request; a reply that arrives after the caller gave up is released. */
  private static final class PendingReply {
    private final String request;
    private Bundle reply;
    private boolean done;
    PendingReply(String request) {
      this.request = request;
    }
    synchronized void offer(Bundle data) {
      if (done || data == null || !request.equals(data.getString("request"))) {
        release(data);
        return;
      }
      reply = data;
      done = true;
      notifyAll();
    }
    synchronized Bundle await(long timeoutMs) throws InterruptedException {
      long end = SystemClock.uptimeMillis() + timeoutMs;
      while (!done) {
        long left = end - SystemClock.uptimeMillis();
        if (left <= 0)
          return null;
        wait(left);
      }
      Bundle out = reply;
      reply = null;
      return out;
    }
    /** Ends the wait; a reply that arrived after the caller timed out is released here. */
    synchronized void abandon() {
      done = true;
      release(reply);
      reply = null;
    }
    private static void release(Bundle data) {
      try {
        Object pixels = data == null ? null : data.getParcelable("pixels");
        if (pixels instanceof SharedMemory)
          ((SharedMemory) pixels).close();
      } catch (RuntimeException ignored) {
      }
    }
  }
  /** A copy of the current selection IDs and documents, for host diagnostics and tests. */
  public synchronized Map<String, Uri> selections() {
    return new LinkedHashMap<>(selected);
  }
  private static JSObject result(String status, String message) {
    JSObject value = new JSObject();
    value.put("status", status);
    value.put("message", message);
    return value;
  }
  /** Bounded UTF-8 text of a selected document (64 KiB). */
  public JSObject read(String id) {
    Uri uri = resolve(id);
    if (uri == null)
      return result("unavailable", "Select this document again before reading it.");
    return readTextUri(owner, uri, false, id);
  }
  // Only native picker callbacks may use this; no renderer-supplied URI entrypoint.
  public JSObject readTransientText(Uri uri) {
    if (uri == null || !"content".equals(uri.getScheme()))
      return result("unavailable", "Select a document first.");
    return readTextUri(owner, uri, true, null);
  }
  private JSObject readTextUri(Context context, Uri uri, boolean preserveBom, String id) {
    try {
      String mime = context.getContentResolver().getType(uri);
      String normalized = mime == null ? "" : mime.toLowerCase(Locale.ROOT).split(";", 2)[0].trim();
      if (!(normalized.startsWith("text/") || normalized.equals("application/json")
              || normalized.equals("application/xml"))) {
        return result(
            "unsupported", "This file type has no text preview. Open it in a compatible app.");
      }
      try (InputStream input = context.getContentResolver().openInputStream(uri)) {
        if (input == null)
          return result("unavailable", "The document provider could not open this selection.");
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        while (bytes.size() <= MAX_TEXT_BYTES) {
          int count =
              input.read(buffer, 0, Math.min(buffer.length, MAX_TEXT_BYTES + 1 - bytes.size()));
          if (count == -1)
            break;
          if (count == 0) {
            int single = input.read();
            if (single == -1)
              break;
            bytes.write(single);
          } else
            bytes.write(buffer, 0, count);
        }
        if (bytes.size() > MAX_TEXT_BYTES)
          return result("too-large",
              "Text preview is limited to 64 KiB. Open this document in a compatible app.");
        String text = StandardCharsets.UTF_8.newDecoder()
                          .onMalformedInput(CodingErrorAction.REPORT)
                          .onUnmappableCharacter(CodingErrorAction.REPORT)
                          .decode(ByteBuffer.wrap(bytes.toByteArray()))
                          .toString();
        if (text.indexOf('\0') >= 0)
          return result("unsupported", "This document does not contain supported UTF-8 text.");
        JSObject value =
            result("read", "Read the selected document on this device. Nothing was uploaded.");
        value.put("text", !preserveBom && text.startsWith("\uFEFF") ? text.substring(1) : text);
        value.put("mimeType", mime);
        value.put("bytes", bytes.size());
        return value;
      }
    } catch (CharacterCodingException error) {
      return result(
          "unsupported", "Text preview requires UTF-8. Open this document in a compatible app.");
    } catch (SecurityException error) {
      forget(id);
      return result("unavailable", "Access expired. Select this document again.");
    } catch (IOException | RuntimeException error) {
      return result("failed", "The document provider could not read this selection.");
    }
  }
  public JSObject share(Activity activity, String id) {
    Uri uri = resolve(id);
    if (uri == null)
      return result("unavailable", "Select this document again before sharing it.");
    return shareUri(activity, uri);
  }
  /**
   * Opens Android sharing for one URI. Callers must first validate a picker capability or an
   * admitted media identity; never pass a renderer-supplied URI.
   */
  public static JSObject shareUri(Activity activity, Uri uri) {
    try {
      try (android.content.res.AssetFileDescriptor file =
               activity.getContentResolver().openAssetFileDescriptor(uri, "r")) {
        if (file == null)
          return result("unavailable", "This item is no longer available.");
      }
      String mime = activity.getContentResolver().getType(uri);
      Intent send = new Intent(Intent.ACTION_SEND)
                        .setType(mime == null ? "application/octet-stream" : mime)
                        .putExtra(Intent.EXTRA_STREAM, uri)
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
      send.setClipData(ClipData.newRawUri("Selected item", uri));
      activity.startActivity(Intent.createChooser(send, "Share"));
      return result("opened", "Choose an app to share this item. Nothing has been sent yet.");
    } catch (SecurityException | java.io.FileNotFoundException error) {
      return result("unavailable", "Access expired or the item was removed. Select it again.");
    } catch (IOException | RuntimeException error) {
      return result("failed", "Android could not open sharing for this item.");
    }
  }
  public JSObject open(Activity activity, String id) {
    Uri uri = resolve(id);
    if (uri == null)
      return result("unavailable", "Select this document again before opening it.");
    try {
      String mime = activity.getContentResolver().getType(uri);
      Intent intent = new Intent(Intent.ACTION_VIEW)
                          .setDataAndType(uri, mime == null ? "*/*" : mime)
                          .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
      intent.setClipData(ClipData.newRawUri("Selected document", uri));
      activity.startActivity(intent);
      return result(
          "opened", "Opened the selected document. Complete any further action in that app.");
    } catch (ActivityNotFoundException error) {
      return result("unavailable", "No compatible app is installed to open this document.");
    } catch (SecurityException error) {
      forget(id);
      return result("unavailable", "Access expired. Select this document again.");
    } catch (RuntimeException error) {
      return result("failed", "Android could not open the selected document.");
    }
  }
}
