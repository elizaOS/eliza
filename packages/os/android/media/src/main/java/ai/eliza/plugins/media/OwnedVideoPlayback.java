package ai.eliza.plugins.media;

import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.io.*;
import java.util.*;

/**
 * Same-origin, process-scoped playback capabilities for one host-validated video at a time: an
 * owned published video, or a selected permitted library video whose revision and access are
 * rechecked on every byte request. The renderer receives an opaque same-origin URL, never a content
 * URI or path; range requests are served from the provider descriptor. Other navigation and
 * requests retain Capacitor's normal security behavior. Install with
 * {@code bridge.setWebViewClient(playback)}.
 */
public final class OwnedVideoPlayback extends BridgeWebViewClient {
  private static final java.util.regex.Pattern PATH =
      java.util.regex.Pattern.compile("/_[a-z][a-z0-9_]{0,39}/");
  /** Default same-origin path prefix for capability URLs. */
  public static final String DEFAULT_PREFIX = "/_owned_video/";
  private final String prefix;
  private final Bridge bridge;
  // Bounded diagnostics contain no URI, capability, filename or media bytes.
  // Read by host instrumentation, never through a renderer bridge.
  private final java.util.concurrent.atomic.AtomicLong intercepted =
      new java.util.concurrent.atomic.AtomicLong();
  private volatile int lastStatus;
  private volatile boolean lastWasRange;
  private volatile String lastRequestedRange = "none";
  private volatile String lastFailure = "";
  public String diagnostics() {
    return "requests=" + intercepted.get() + ",status=" + lastStatus + ",range=" + lastWasRange
        + ",requested=" + lastRequestedRange + ",failure=" + lastFailure;
  }

  private static final class Grant {
    final Uri uri;
    final Runnable check;
    volatile boolean revoked;
    Grant(Uri uri, Runnable check) {
      this.uri = uri;
      this.check = check;
    }
  }
  private final LinkedHashMap<String, Grant> grants = new LinkedHashMap<>();
  public OwnedVideoPlayback(Bridge bridge) {
    this(bridge, DEFAULT_PREFIX);
  }
  /** {@code pathPrefix}: a host-chosen same-origin path such as {@code "/_myapp_owned_video/"}. */
  public OwnedVideoPlayback(Bridge bridge, String pathPrefix) {
    super(bridge);
    if (pathPrefix == null || !PATH.matcher(pathPrefix).matches())
      throw new IllegalArgumentException("Invalid playback path prefix");
    this.bridge = bridge;
    prefix = pathPrefix;
  }
  public synchronized String authorize(Uri uri) {
    return authorize(uri, null);
  }
  /**
   * A host-validated selected library video; every byte request rechecks its revision and access.
   */
  public synchronized String authorize(Uri uri, Runnable check) {
    String key = UUID.randomUUID().toString() + ".mp4";
    grants.put(key, new Grant(uri, check));
    while (grants.size() > 32) grants.remove(grants.keySet().iterator().next()).revoked = true;
    return bridge.getLocalUrl().replaceAll("/$", "") + prefix + key;
  }
  public synchronized void clear() {
    for (Grant grant : grants.values()) grant.revoked = true;
    grants.clear();
  }
  public synchronized void revoke(Uri uri) {
    grants.entrySet().removeIf(entry -> {
      if (!entry.getValue().uri.equals(uri))
        return false;
      entry.getValue().revoked = true;
      return true;
    });
  }
  private WebResourceResponse empty(int code, String reason) {
    lastStatus = code;
    return new WebResourceResponse("text/plain", "UTF-8", code, reason,
        Collections.singletonMap("Cache-Control", "no-store"),
        new ByteArrayInputStream(new byte[0]));
  }
  @Override
  public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
    Uri url = request.getUrl();
    if (url.getPath() == null || !url.getPath().startsWith(prefix))
      return super.shouldInterceptRequest(view, request);
    intercepted.incrementAndGet();
    lastFailure = "";
    lastWasRange = false;
    Uri origin = Uri.parse(bridge.getLocalUrl());
    if (!Objects.equals(origin.getScheme(), url.getScheme())
        || !Objects.equals(origin.getAuthority(), url.getAuthority()) || request.isForMainFrame())
      return empty(403, "Forbidden");
    if (!"GET".equals(request.getMethod()) && !"HEAD".equals(request.getMethod()))
      return empty(405, "Method Not Allowed");
    Grant grant;
    synchronized (this) {
      grant = grants.get(url.getPath().substring(prefix.length()));
    }
    if (grant == null)
      return empty(404, "Not Found");
    Uri uri = grant.uri;
    ParcelFileDescriptor descriptor = null;
    try {
      ContentResolver resolver = bridge.getContext().getContentResolver();
      if (grant.check != null)
        grant.check.run();
      else {
        String selection = MediaStore.MediaColumns.OWNER_PACKAGE_NAME + "=? AND is_pending=0"
            + (Build.VERSION.SDK_INT >= 30 ? " AND is_trashed=0" : "");
        try (Cursor row = resolver.query(uri, new String[] {"_id"}, selection,
                 new String[] {bridge.getContext().getPackageName()}, null)) {
          if (row == null || !row.moveToFirst())
            return empty(404, "Not Found");
        }
      }
      descriptor = resolver.openFileDescriptor(uri, "r");
      if (descriptor == null)
        return empty(404, "Not Found");
      if (grant.check != null)
        grant.check.run();
      long length = descriptor.getStatSize();
      if (length <= 0)
        throw new IOException();
      long start = 0, end = length - 1;
      String range = null;
      for (Map.Entry<String, String> h : request.getRequestHeaders().entrySet())
        if (h.getKey().equalsIgnoreCase("Range"))
          range = h.getValue();
      lastWasRange = range != null;
      lastRequestedRange = range == null                                 ? "none"
          : range.length() <= 80 && range.matches("bytes=[0-9]*-[0-9]*") ? range
                                                                         : "unsupported";
      if (range != null) {
        if (!range.matches("bytes=\\d*-\\d*"))
          return empty(416, "Range Not Satisfiable");
        String[] values = range.substring(6).split("-", -1);
        if (values[0].isEmpty()) {
          long suffix = Long.parseLong(values[1]);
          if (suffix <= 0)
            return empty(416, "Range Not Satisfiable");
          start = Math.max(0, length - suffix);
        } else {
          start = Long.parseLong(values[0]);
          if (!values[1].isEmpty())
            end = Math.min(end, Long.parseLong(values[1]));
        }
        if (start < 0 || start >= length || end < start)
          return empty(416, "Range Not Satisfiable");
      }
      // AndroidStreamReaderURLLoader computes Content-Length from Seek(range)
      // before AppendResponseHeaders appends these Java headers. Supplying it here
      // produces a duplicate (e.g. "16, 16"). Let Chromium own that header.
      Map<String, String> headers = new HashMap<>();
      headers.put("Cache-Control", "no-store");
      headers.put("Accept-Ranges", "bytes");
      headers.put("X-Content-Type-Options", "nosniff");
      if (range != null)
        headers.put("Content-Range", "bytes " + start + "-" + end + "/" + length);
      InputStream body;
      if ("HEAD".equals(request.getMethod()))
        body = new ByteArrayInputStream(new byte[0]);
      else {
        // Chromium's AndroidStreamReaderURLLoader seeks the Java response stream
        // using the REQUEST Range before exposing WebResourceResponse headers. It
        // computes bounds from available(), then calls skip(start) itself. Returning
        // an already-seeked slice double-applies the offset (or fails bounds checks).
        // Keep offset zero and the original available length; bound reads at end+1.
        // Chromium then performs the one start skip, including suffix ranges.
        // https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/embedder_support/android/util/input_stream_reader.cc
        FileInputStream stream = new ParcelFileDescriptor.AutoCloseInputStream(descriptor);
        descriptor = null;
        final long limit = end + 1;
        body = new FilterInputStream(stream) {
          long left = limit;
          private void admitted() throws IOException {
            if (grant.revoked)
              throw new IOException("Video access ended");
            if (grant.check != null) {
              android.app.KeyguardManager keyguard =
                  bridge.getContext().getSystemService(android.app.KeyguardManager.class);
              android.os.UserManager users =
                  bridge.getContext().getSystemService(android.os.UserManager.class);
              if (keyguard == null || users == null || keyguard.isDeviceLocked()
                  || !users.isUserUnlocked())
                throw new IOException("Video profile locked");
            }
          }
          @Override
          public int read() throws IOException {
            admitted();
            if (left == 0)
              return -1;
            int b = in.read();
            if (b >= 0)
              left--;
            return b;
          }
          @Override
          public int read(byte[] b, int off, int len) throws IOException {
            admitted();
            if (len == 0)
              return 0;
            if (left == 0)
              return -1;
            int n = in.read(b, off, (int) Math.min(len, left));
            if (n > 0)
              left -= n;
            return n;
          }
          @Override
          public long skip(long count) throws IOException {
            admitted();
            long n = in.skip(Math.max(0, Math.min(count, left)));
            left -= n;
            return n;
          }
          @Override
          public int available() throws IOException {
            admitted();
            return in.available();
          }
        };
      }
      lastStatus = range == null ? 200 : 206;
      return new WebResourceResponse("video/mp4", null, range == null ? 200 : 206,
          range == null ? "OK" : "Partial Content", headers, body);
    } catch (Exception failure) {
      lastFailure = failure.getClass().getSimpleName();
      return empty(404, "Not Found");
    } finally {
      if (descriptor != null)
        try {
          descriptor.close();
        } catch (IOException ignored) {
        }
    }
  }
}
