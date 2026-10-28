package ai.eliza.plugins.browsersurface;

import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Log;
import android.webkit.URLUtil;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import androidx.annotation.RequiresApi;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.function.BooleanSupplier;
import java.util.function.Predicate;
import java.util.function.Supplier;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Browser downloads for a host with persistent and private WebView profiles, always after an
 * explicit native review.
 *
 * <p>HTTPS files without a sign-in go to the OS DownloadManager. A file that uses the requesting
 * tab's own profile cookie (exact same origin as its committed page, read at confirmation while
 * that tab is still open) is fetched by the host instead: DownloadManager would replay a Cookie
 * header to every redirect target and keep it in Android's download database after the tab, even a
 * private one, is gone. No bearer tokens, referer or form bodies are copied. {@code blob:} and
 * {@code data:} links are captured into a host-owned cache file ({@code blob:} through {@link
 * BrowserBlobCapture}) and copied to Downloads only after review. Private-tab entries are never
 * written to the persisted list ({@link BrowserDownloadPolicy.History}). Completion always comes
 * from the provider's actual row.
 *
 * <p>A review is bound to the requesting tab: the host's {@code current} check runs again at
 * confirmation, and {@link #cancelReview} dismisses it when that tab navigates or closes.
 */
@RequiresApi(Build.VERSION_CODES.Q)
public final class BrowserDownloads {
  public static final int MAX_REDIRECTS = 10;

  /** Host storage identity and loopback policy. */
  public static final class Config {
    /** SharedPreferences file for the persisted list; keep a deployed name to retain history. */
    public final String preferences;
    /** Development-only: also allow http downloads from 127.0.0.1 and localhost. */
    public final boolean allowLoopback;

    public Config(String preferences, boolean allowLoopback) {
      if (preferences == null || preferences.isEmpty())
        throw new IllegalArgumentException("preferences");
      this.preferences = preferences;
      this.allowLoopback = allowLoopback;
    }
  }

  /** The requesting tab, captured by the host at download start. */
  public static final class Source {
    final String tab, pageOrigin;
    final boolean priv;
    final Supplier<String> cookies;
    final String userAgent;

    /**
     * @param tab the requesting tab's id; required for a private tab, whose entries are forgotten
     *     when that tab closes.
     * @param cookies reads the tab's own profile cookie for the download address at confirmation;
     *     returns null once the tab is closed.
     */
    public Source(String tab, boolean priv, String pageOrigin, Supplier<String> cookies, String userAgent) {
      // Checked here, in the host's call, rather than when a finished file is listed.
      if (priv && (tab == null || tab.isEmpty()))
        throw new IllegalArgumentException("a private download source needs its tab");
      this.tab = tab;
      this.priv = priv;
      this.pageOrigin = pageOrigin;
      this.cookies = cookies;
      this.userAgent = userAgent;
    }
  }

  private final Context context;
  private final Config config;
  private final DownloadManager manager;
  private final SharedPreferences preferences;
  private final Handler handler = new Handler(Looper.getMainLooper());
  private final ExecutorService io = Executors.newSingleThreadExecutor();
  /** Signed-in downloads fetched by the host, one at a time; progress and cancellation by entry id. */
  private final ExecutorService network = Executors.newSingleThreadExecutor();
  private final Map<Long, Long> received = new ConcurrentHashMap<>();
  private final Set<Long> cancelled = ConcurrentHashMap.newKeySet();
  private AlertDialog pending, listing;
  private String pendingTab;
  private Runnable update;
  /** Positive ids are DownloadManager IDs; negative ids are files the host saved to MediaStore. */
  private static final String TAG = "BrowserDownloads";
  private final BrowserDownloadPolicy.History history = new BrowserDownloadPolicy.History();
  private long localSequence;
  /** Set by destroy(): the activity is gone, so no dialog may be shown and no worker accepts work. */
  private volatile boolean closed;
  /** The saved download list could not be read; see {@link #historyUnreadable()}. */
  private final boolean historyUnreadable;

  public BrowserDownloads(Context context, Config config) {
    this.context = context;
    this.config = config;
    manager = context.getSystemService(DownloadManager.class);
    preferences = context.getSharedPreferences(config.preferences, Context.MODE_PRIVATE);
    List<BrowserDownloadPolicy.Entry> saved = new ArrayList<>();
    boolean unreadable = false;
    try {
      JSONArray records = new JSONArray(preferences.getString("owned", "[]"));
      for (int i = 0; i < records.length(); i++) {
        JSONObject item = records.getJSONObject(i);
        long id = item.getLong("id");
        if (id < localSequence)
          localSequence = id;
        // A private or running row can only exist in a store written by an older build.
        if (id == 0 || item.optBoolean("private", false) || item.optBoolean("running", false))
          continue;
        saved.add(new BrowserDownloadPolicy.Entry(id, item.optString("name"), item.optString("origin"),
            false, null, item.has("uri") ? item.optString("uri") : null, false,
            item.optBoolean("failed", false)));
      }
    } catch (Exception corrupt) {
      // No outside IDs are queried. A corrupt store is reported rather than shown as an empty
      // history; the unreadable record is kept aside so the next persist() does not erase it.
      unreadable = true;
      saved.clear();
      Log.w(TAG, "Saved download history is unreadable; starting with an empty list", corrupt);
      preferences.edit()
          .putString("owned_unreadable", preferences.getString("owned", ""))
          .apply();
    }
    historyUnreadable = unreadable;
    history.restore(saved);
  }

  /**
   * True when the saved download list could not be read at construction. The host should tell the
   * user that earlier downloads are not listed (the files themselves are untouched).
   */
  public boolean historyUnreadable() {
    return historyUnreadable;
  }

  /** Persist only finished normal-tab entries. Private-tab entries live in memory until their tab closes. */
  private void persist() {
    JSONArray records = new JSONArray();
    try {
      for (BrowserDownloadPolicy.Entry entry : history.persistable()) {
        JSONObject item = new JSONObject().put("id", entry.id).put("name", entry.name).put("origin", entry.origin);
        if (entry.uri != null)
          item.put("uri", entry.uri);
        if (entry.failed)
          item.put("failed", true);
        records.put(item);
      }
    } catch (Exception unavailable) {
      return;
    }
    preferences.edit().putString("owned", records.toString()).apply();
  }

  public static String safeName(String raw, String disposition, String mime) {
    return BrowserDownloadPolicy.sanitizeName(URLUtil.guessFileName(raw, disposition, mime));
  }

  public static boolean validMime(String mime) {
    return BrowserDownloadPolicy.validMime(mime);
  }

  private static String size(long bytes) {
    return bytes < 0 ? "Size unknown" : bytes + " bytes";
  }

  private boolean loopbackAllowed(Uri uri) {
    return config.allowLoopback && "http".equals(uri.getScheme())
        && ("127.0.0.1".equals(uri.getHost()) || "localhost".equals(uri.getHost()));
  }

  private boolean allowed(Uri uri) {
    if (uri.getHost() == null || uri.getUserInfo() != null)
      return false;
    return "https".equalsIgnoreCase(uri.getScheme()) || loopbackAllowed(uri);
  }

  /** Runs download work on a worker that destroy() stops; dropped work runs its cleanup instead. */
  private void work(ExecutorService worker, Runnable task, Runnable dropped) {
    try {
      worker.execute(task);
    } catch (RejectedExecutionException stopped) {
      dropped.run();
    }
  }

  private void message(String text) {
    if (closed)
      return;
    new AlertDialog.Builder(context).setTitle("Download").setMessage(text).setPositiveButton("Close", null).show();
  }

  private static String privateNote(boolean priv) {
    return priv ? "\n\nPrivate tab: the file stays in Downloads after you close this tab, but it is not kept in the browser's download list."
                : "";
  }

  private boolean reviewable() {
    if (closed)
      return false;
    if (pending != null) {
      message("Finish the current download review first.");
      return false;
    }
    if (history.full()) {
      message("Download history is full. Remove an entry from Downloads first.");
      return false;
    }
    return true;
  }

  private void review(String tab, String title, String details, Runnable confirm) {
    if (closed)
      return;
    pendingTab = tab;
    pending = new AlertDialog.Builder(context).setTitle(title).setMessage(details).setNegativeButton("Cancel", null)
                  .setPositiveButton("Download", (dialog, which) -> confirm.run()).create();
    AlertDialog review = pending;
    review.setOnDismissListener(dialog -> {
      if (pending == review) {
        pending = null;
        pendingTab = null;
      }
    });
    review.show();
  }

  private static BrowserDownloadPolicy.Entry entry(long id, String name, String origin, Source source) {
    return new BrowserDownloadPolicy.Entry(id, name, origin, source.priv, source.priv ? source.tab : null);
  }

  /** Review a WebView download request of {@code source}'s committed page. */
  public void request(Source source, String raw, String disposition, String mime, long length, BooleanSupplier current) {
    if (raw != null && raw.regionMatches(true, 0, "data:", 0, 5)) {
      requestData(source, raw, disposition, mime, current);
      return;
    }
    Uri uri;
    try {
      uri = Uri.parse(raw);
      if (raw.length() > 8192 || raw.matches("(?s).*[\\x00-\\x1f\\x7f].*") || !allowed(uri))
        throw new IllegalArgumentException();
    } catch (Exception invalid) {
      message("Only HTTPS file downloads are supported.");
      return;
    }
    if (manager == null) {
      message("Android downloads are unavailable.");
      return;
    }
    if (!reviewable())
      return;
    String name = safeName(raw, disposition, mime);
    String origin = BrowserWebOrigin.of(raw);
    boolean signedIn = BrowserDownloadPolicy.cookieAllowed(raw, source.pageOrigin, true);
    String details = "From: " + origin + "\nFile: " + name + "\nAdvertised size: " + size(length)
        + "\n\nSave to Downloads? The final size may differ. "
        + (signedIn ? "Your sign-in for this site is used for this download only."
                    : "Website sign-in is not shared with other sites.")
        + privateNote(source.priv)
        + (signedIn && source.priv ? " Closing this tab before the download finishes cancels it." : "");
    review(source.tab, "Download file?", details, () -> {
      if (!current.getAsBoolean()) {
        message("The source page changed. Start the download again.");
        return;
      }
      try {
        String destination = UUID.randomUUID().toString().substring(0, 8) + "-" + name;
        DownloadManager.Request request = new DownloadManager.Request(uri).setTitle(name).setDescription(origin)
            .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, destination)
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        if (validMime(mime))
          request.setMimeType(mime);
        if (source.userAgent != null && !source.userAgent.isEmpty() && source.userAgent.length() < 1024)
          request.addRequestHeader("User-Agent", source.userAgent);
        // Read now, from the still-open requesting tab's own profile. A closed tab supplies nothing.
        if (signedIn) {
          String cookie = source.cookies == null ? null : source.cookies.get();
          if (BrowserDownloadPolicy.cookieHeaderAcceptable(cookie)) {
            fetchSignedIn(raw, name, mime, origin, source, cookie);
            show();
            return;
          }
        }
        // No sign-in: DownloadManager never receives a Cookie header.
        long id = manager.enqueue(request);
        if (!history.add(entry(id, name, origin, source))) {
          message("Download started. It is not shown in this list.");
          return;
        }
        persist();
        show();
      } catch (Exception error) {
        message("The download could not be queued. Check Android storage and try again.");
      }
    });
  }

  /** data: URLs carry their bytes inline; decode natively, never through page script. */
  private void requestData(Source source, String raw, String disposition, String mime, BooleanSupplier current) {
    byte[] bytes;
    try {
      bytes = BrowserDownloadPolicy.decodeData(raw);
    } catch (Exception invalid) {
      message("This embedded file is invalid or larger than " + (BrowserDownloadPolicy.MAX_CAPTURE / 1048576) + " MB.");
      return;
    }
    String type = validMime(mime) ? mime : BrowserDownloadPolicy.dataMime(raw);
    File file;
    try {
      file = captureFile();
      try (OutputStream out = new FileOutputStream(file)) {
        out.write(bytes);
      }
    } catch (Exception unavailable) {
      message("The file could not be prepared. Check Android storage and try again.");
      return;
    }
    reviewCaptured(source, file, safeName("download", disposition, type), type, current);
  }

  private File captureFile() throws Exception {
    File directory = captureDirectory();
    if (!directory.isDirectory() && !directory.mkdirs())
      throw new IllegalStateException();
    return new File(directory, UUID.randomUUID().toString());
  }

  /** Review a host-owned captured file, then copy it to Downloads. The capture is deleted either way. */
  public void reviewCaptured(Source source, File file, String name, String mime, BooleanSupplier current) {
    if (!reviewable()) {
      file.delete();
      return;
    }
    String origin = source.pageOrigin == null ? "this page" : source.pageOrigin;
    String details = "From: " + origin + " (file created by the page)\nFile: " + name + "\nSize: "
        + size(file.length()) + "\n\nSave to Downloads?" + privateNote(source.priv);
    boolean[] used = {false};
    review(source.tab, "Download file?", details, () -> {
      used[0] = true;
      if (!current.getAsBoolean()) {
        file.delete();
        message("The source page changed. Start the download again.");
        return;
      }
      work(io, () -> {
        Uri saved = null;
        String failure = null;
        try {
          saved = publish(file, name, mime);
        } catch (Exception error) {
          failure = "The file could not be saved to Downloads. Check Android storage and try again.";
        } finally {
          file.delete();
        }
        Uri result = saved;
        String error = failure;
        handler.post(() -> {
          if (result == null) {
            message(error);
            return;
          }
          // Reviews are refused while the list is full; a result that still finds it full is saved but unlisted.
          if (!history.add(entry(--localSequence, name, origin, source).finished(result.toString()))) {
            message("Saved to Downloads.");
            return;
          }
          persist();
          show();
        });
      }, file::delete);
    });
    AlertDialog review = pending;
    if (review != null)
      review.setOnDismissListener(dialog -> {
        if (pending == review) {
          pending = null;
          pendingTab = null;
        }
        if (!used[0])
          file.delete();
      });
  }

  /** Thrown by the fetch loop when the user cancelled or removed the entry. */
  private static final class Cancelled extends Exception {
    Cancelled() {
      super(null, null, false, false);
    }
  }

  /** A failure whose fixed message is shown to the user. */
  private static final class Refused extends Exception {
    Refused(String message) {
      super(message, null, false, false);
    }
  }

  /**
   * Fetch a signed-in file in-app. The cookie is sent on each hop only when that hop's URL has
   * exactly the page's origin; redirects are followed manually, only to allowed (HTTPS) addresses,
   * and the cookie is never stored. The entry is in memory while running and persisted on success
   * (normal tabs only). A fetch interrupted by process death leaves only Android's pending row,
   * which the system removes.
   */
  private void fetchSignedIn(String start, String name, String mime, String origin, Source source, String cookie) {
    long id = --localSequence;
    if (!history.add(entry(id, name, origin, source).started()))
      throw new IllegalStateException("Download history is full");
    received.put(id, 0L);
    work(network, () -> {
      Uri saved = null;
      String failure = null;
      boolean stopped = false;
      try {
        saved = fetch(id, start, source.pageOrigin, cookie, source.userAgent, name, mime);
      } catch (Cancelled cancel) {
        stopped = true;
      } catch (Refused refused) {
        failure = refused.getMessage();
      } catch (Exception error) {
        failure = "The download failed. Check the connection and try again.";
      }
      Uri result = saved;
      String error = failure;
      boolean wasCancelled = stopped;
      handler.post(() -> {
        received.remove(id);
        cancelled.remove(id);
        BrowserDownloadPolicy.Entry current = history.get(id);
        // Removed, cancelled or cleared while running: nothing is re-added. A finished file stays in Downloads.
        if (current == null || wasCancelled)
          return;
        history.replace(current.finished(result == null ? null : result.toString()));
        persist();
        if (update != null)
          update.run();
        if (result == null && error != null)
          message(error);
      });
    }, () -> {
      history.remove(id);
      received.remove(id);
    });
  }

  private Uri fetch(long id, String start, String pageOrigin, String cookie, String agent, String name, String mime) throws Exception {
    URL url = new URL(start);
    for (int hop = 0;; hop++) {
      if (hop > MAX_REDIRECTS)
        throw new Refused("The site redirected the download too many times.");
      if (cancelled.contains(id))
        throw new Cancelled();
      HttpURLConnection connection = (HttpURLConnection) url.openConnection();
      try {
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);
        connection.setConnectTimeout(30000);
        connection.setReadTimeout(60000);
        connection.setRequestProperty("Accept-Encoding", "identity");
        if (agent != null && !agent.isEmpty() && agent.length() < 1024 && !agent.matches("(?s).*[\\r\\n].*"))
          connection.setRequestProperty("User-Agent", agent);
        // Only the exact page origin gets the sign-in, on this hop and on any redirect back to it.
        if (BrowserDownloadPolicy.cookieAllowed(url.toString(), pageOrigin, true))
          connection.setRequestProperty("Cookie", cookie);
        int code = connection.getResponseCode();
        if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
          String location = connection.getHeaderField("Location");
          if (location == null || location.length() > 8192 || location.matches("(?s).*[\\x00-\\x1f\\x7f].*"))
            throw new Refused("The site redirected the download to an invalid address.");
          URL next = new URL(url, location);
          if (!allowed(Uri.parse(next.toString())))
            throw new Refused("The site redirected the download to an address that is not supported.");
          url = next;
          continue;
        }
        if (code < 200 || code >= 300)
          throw new Refused("The site did not provide the file (HTTP " + code + ").");
        String type = connection.getContentType();
        if (type != null)
          type = type.split(";", 2)[0].trim();
        try (InputStream in = connection.getInputStream()) {
          return publish(in, name, validMime(mime) ? mime : validMime(type) ? type : null, id);
        }
      } finally {
        connection.disconnect();
      }
    }
  }

  private Uri publish(File file, String name, String mime) throws Exception {
    try (InputStream in = new FileInputStream(file)) {
      return publish(in, name, mime, 0);
    }
  }

  /** Stream into a pending MediaStore Downloads row; a failed or cancelled copy removes it. */
  private Uri publish(InputStream in, String name, String mime, long id) throws Exception {
    ContentResolver resolver = context.getContentResolver();
    ContentValues values = new ContentValues();
    values.put(MediaStore.MediaColumns.DISPLAY_NAME, UUID.randomUUID().toString().substring(0, 8) + "-" + name);
    values.put(MediaStore.MediaColumns.MIME_TYPE, validMime(mime) ? mime : "application/octet-stream");
    values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
    values.put(MediaStore.MediaColumns.IS_PENDING, 1);
    Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
    if (uri == null)
      throw new IllegalStateException();
    try (OutputStream out = resolver.openOutputStream(uri)) {
      if (out == null)
        throw new IllegalStateException();
      byte[] buffer = new byte[65536];
      int count;
      long total = 0;
      while ((count = in.read(buffer)) != -1) {
        if (id != 0 && cancelled.contains(id))
          throw new Cancelled();
        out.write(buffer, 0, count);
        total += count;
        if (id != 0)
          received.put(id, total);
      }
    } catch (Exception failure) {
      resolver.delete(uri, null, null);
      throw failure;
    }
    ContentValues done = new ContentValues();
    done.put(MediaStore.MediaColumns.IS_PENDING, 0);
    resolver.update(uri, done, null, null);
    return uri;
  }

  /** The requesting tab navigated or closed: its open review ends unanswered. */
  public void cancelReview(String tab) {
    if (Objects.equals(pendingTab, tab) && pending != null)
      pending.dismiss();
  }

  /**
   * Removing an entry that is still being fetched by the host stops that fetch: its sign-in cookie
   * is never sent again (on a redirect hop) once the entry, its tab or its site data is gone, and
   * nothing keeps downloading where the user can no longer see or cancel it.
   */
  private boolean removeEntries(Predicate<BrowserDownloadPolicy.Entry> match) {
    List<BrowserDownloadPolicy.Entry> removed = history.removeWhere(match);
    for (BrowserDownloadPolicy.Entry entry : removed)
      if (entry.id < 0 && entry.running)
        cancelled.add(entry.id);
    return !removed.isEmpty();
  }

  /** A private tab closed: forget its in-memory entries and stop its unfinished signed-in fetches. Files already saved stay in Downloads. */
  public void forgetPrivate(String tab) {
    boolean changed = removeEntries(entry -> entry.ephemeral && tab.equals(entry.tab));
    if (changed && update != null)
      update.run();
  }

  /** Clear browsing data: the download list (normal and private); unfinished signed-in fetches stop. Saved files and OS transfers (which never carry a cookie) remain. */
  public void clearHistory() {
    removeEntries(entry -> true);
    persist();
    if (listing != null) {
      listing.dismiss();
      listing = null;
    }
  }

  /** Clear data for this site: entries of the cleared site or its subdomains; their unfinished signed-in fetches stop. */
  public void clearSite(String site) {
    if (site == null || site.isEmpty())
      return;
    boolean changed = removeEntries(entry -> BrowserWebOrigin.withinSite(entry.origin, site));
    persist();
    if (changed && update != null)
      update.run();
  }

  /** Shows the download list with live status. */
  public void show() {
    if (closed)
      return;
    if (listing != null) {
      listing.dismiss();
      listing = null;
    }
    LinearLayout rows = new LinearLayout(context);
    rows.setOrientation(LinearLayout.VERTICAL);
    int padding = (int) (16 * context.getResources().getDisplayMetrics().density);
    rows.setPadding(padding, padding, padding, padding);
    ScrollView scroll = new ScrollView(context);
    scroll.addView(rows);
    listing = new AlertDialog.Builder(context).setTitle("Downloads").setView(scroll).setPositiveButton("Close", null).create();
    AlertDialog list = listing;
    Runnable poll = new Runnable() {
      public void run() {
        if (listing != list)
          return;
        render(rows);
        handler.removeCallbacks(this);
        handler.postDelayed(this, 1000);
      }
    };
    list.setOnDismissListener(dialog -> {
      handler.removeCallbacks(poll);
      if (listing == list) {
        update = null;
        listing = null;
      }
    });
    update = poll;
    list.show();
    poll.run();
  }

  private String localLabel(BrowserDownloadPolicy.Entry entry) {
    if (entry.running)
      return "Downloading · " + size(received.getOrDefault(entry.id, 0L));
    if (entry.failed)
      return "Failed";
    try (Cursor cursor = context.getContentResolver().query(Uri.parse(entry.uri == null ? "" : entry.uri), new String[] {MediaStore.MediaColumns.SIZE}, null, null, null)) {
      if (cursor != null && cursor.moveToFirst())
        return "Saved to Downloads · " + size(cursor.getLong(0));
    } catch (Exception unavailable) {
      return "Status unavailable";
    }
    return "Removed from Android downloads";
  }

  private void render(LinearLayout rows) {
    rows.removeAllViews();
    List<BrowserDownloadPolicy.Entry> entries = history.all();
    if (entries.isEmpty()) {
      TextView empty = new TextView(context);
      empty.setText("No downloads yet.");
      rows.addView(empty);
      return;
    }
    for (BrowserDownloadPolicy.Entry entry : entries) {
      long id = entry.id;
      int status = 0, reason = 0;
      long bytes = 0, total = -1;
      String label;
      if (id < 0)
        label = localLabel(entry);
      else {
        try (Cursor cursor = manager.query(new DownloadManager.Query().setFilterById(id))) {
          if (cursor != null && cursor.moveToFirst()) {
            status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
            bytes = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
            total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
          }
        } catch (Exception unavailable) {
          status = -1;
        }
        switch (status) {
          case DownloadManager.STATUS_SUCCESSFUL: label = "Complete · " + size(bytes); break;
          case DownloadManager.STATUS_FAILED: label = "Failed · Android reason " + reason; break;
          case DownloadManager.STATUS_PAUSED: label = "Waiting · Android reason " + reason; break;
          case DownloadManager.STATUS_RUNNING: label = "Downloading · " + size(bytes) + " / " + size(total); break;
          case DownloadManager.STATUS_PENDING: label = "Queued"; break;
          case -1: label = "Status unavailable"; break;
          default: label = "Removed from Android downloads";
        }
      }
      if (entry.ephemeral)
        label += " · Private tab";
      TextView text = new TextView(context);
      text.setText(entry.name + "\n" + (entry.origin == null ? "" : entry.origin) + "\n" + label);
      text.setPadding(0, 12, 0, 8);
      rows.addView(text);
      boolean active = (id < 0 && entry.running)
          || (id > 0 && (status == DownloadManager.STATUS_PENDING || status == DownloadManager.STATUS_RUNNING || status == DownloadManager.STATUS_PAUSED));
      Button control = new Button(context);
      control.setText(active ? "Cancel download" : "Remove entry");
      control.setContentDescription((active ? "Cancel download " : "Remove download entry ") + entry.name);
      control.setOnClickListener(view -> {
        try {
          if (active) {
            if (id > 0)
              manager.remove(id);
            else
              cancelled.add(id);
          }
          history.remove(id);
          persist();
          render(rows);
        } catch (Exception error) {
          message("Android could not cancel this download. Try again.");
        }
      });
      rows.addView(control);
    }
  }

  /** Dismiss only UI; OS-owned transfers and durable history remain intact. */
  public void dismissDialogs() {
    if (update != null)
      handler.removeCallbacks(update);
    update = null;
    AlertDialog review = pending, list = listing;
    pending = null;
    pendingTab = null;
    listing = null;
    if (review != null)
      review.dismiss();
    if (list != null)
      list.dismiss();
  }

  public void destroy() {
    closed = true;
    dismissDialogs();
    cancelled.addAll(received.keySet());
    io.shutdown();
    network.shutdown();
  }

  /** Where blob: and data: captures are written before review. */
  public File captureDirectory() {
    return new File(context.getCacheDir(), "browser-captures");
  }

  /** Startup: remove captures abandoned by a previous process. */
  public void purgeStaleCaptures() {
    File[] stale = captureDirectory().listFiles();
    if (stale != null)
      for (File file : stale)
        file.delete();
  }
}
