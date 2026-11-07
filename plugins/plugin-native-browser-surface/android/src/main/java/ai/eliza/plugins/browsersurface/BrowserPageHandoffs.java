package ai.eliza.plugins.browsersurface;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

/**
 * Decisions for the moments a website hands control to someone else: a JavaScript dialog, a new
 * window, a sign-in page that refuses embedded WebViews, or a file download.
 *
 * <p>The surface never answers for the person. A dialog waits for the host's answer and is
 * dismissed (never accepted) when nobody can answer it. A new window never opens by itself: a
 * window the person asked for is reported to the host, which checks the address and loads it in the
 * same surface; a script popup is refused. Pure JVM; no Android types.
 */
public final class BrowserPageHandoffs {
  /** Longest dialog text and prompt answer reported or accepted, in characters. */
  public static final int MAX_TEXT = 2000;
  /** Unanswered dialogs one surface may hold; more are dismissed at once. */
  public static final int MAX_PENDING_DIALOGS = 4;

  private BrowserPageHandoffs() {}

  public enum DialogKind {
    ALERT("alert"),
    CONFIRM("confirm"),
    PROMPT("prompt"),
    BEFORE_UNLOAD("beforeunload");

    public final String wire;

    DialogKind(String wire) {
      this.wire = wire;
    }
  }

  /** Website text as plain bounded text: control characters become spaces, never markup. */
  public static String text(String raw) {
    if (raw == null)
      return "";
    StringBuilder out = new StringBuilder(Math.min(raw.length(), MAX_TEXT));
    for (int i = 0; i < raw.length() && out.length() < MAX_TEXT; i++) {
      char c = raw.charAt(i);
      out.append(c == '\n' || (c >= 0x20 && c != 0x7f) ? c : ' ');
    }
    return out.toString();
  }

  /**
   * Whether a page dialog may wait for the host. A dialog of a hidden, retired or closing surface is
   * dismissed at once, because a dialog nobody sees must never be answered for the person.
   */
  public static boolean dialogMayWait(boolean active, boolean foregrounded, int pending) {
    return active && foregrounded && pending < MAX_PENDING_DIALOGS;
  }

  /**
   * Pending dialog results of one surface, keyed by an unguessable id. Confined to the UI thread.
   * {@link #take} hands a result out once, so a late or repeated answer does nothing.
   */
  public static final class Dialogs<T> {
    private final Map<String, T> pending = new LinkedHashMap<>();

    public int size() {
      return pending.size();
    }

    public String open(T result) {
      String id = UUID.randomUUID().toString();
      pending.put(id, result);
      return id;
    }

    public T take(String id) {
      return id == null ? null : pending.remove(id);
    }

    /** Every pending result, removed; the caller dismisses each one. */
    public List<T> drain() {
      List<T> all = new ArrayList<>(pending.values());
      pending.clear();
      return all;
    }
  }

  public enum WindowDecision {
    /** Report the address to the host; it loads it in this surface after its own check. */
    REQUEST,
    /** Refuse: a script popup the person did not ask for, or no web address. */
    BLOCK
  }

  /** {@code window.open} and {@code target=_blank}: only a window the person tapped for is reported. */
  public static WindowDecision window(boolean userGesture, String target) {
    if (!userGesture)
      return WindowDecision.BLOCK;
    return BrowserWebOrigin.of(target) == null ? WindowDecision.BLOCK : WindowDecision.REQUEST;
  }

  /**
   * The identity provider whose sign-in refuses embedded WebViews ({@code disallowed_useragent}),
   * or null. Google refuses every embedded sign-in page on accounts.google.com; Facebook refuses
   * its OAuth dialog. The host opens such an address in a full browser and brings the person back.
   */
  public static String identityProvider(String url) {
    String origin = BrowserWebOrigin.of(url);
    if (origin == null || !origin.startsWith("https://"))
      return null;
    String host = BrowserWebOrigin.host(origin);
    if ("accounts.google.com".equals(host))
      return "google";
    if (host != null && (host.equals("facebook.com") || host.endsWith(".facebook.com"))) {
      String path = pathOf(url).toLowerCase(Locale.ROOT);
      if (path.matches("(/v[0-9.]+)?/dialog/oauth.*"))
        return "facebook";
    }
    return null;
  }

  private static String pathOf(String url) {
    try {
      String path = new java.net.URI(url).getRawPath();
      return path == null ? "" : path;
    } catch (Exception invalid) {
      return "";
    }
  }

  /**
   * A website download as the host sees it: never started by the surface. The address is reported
   * only for http(s) (a {@code data:} or {@code blob:} body stays in the page) and is never meant
   * for a model, a thread or a log, because download addresses often carry access tokens.
   */
  public static final class Download {
    public final String url;
    public final String fileName;
    public final String mimeType;
    public final long contentLength;
    public final boolean pdf;

    public Download(String url, String fileName, String mimeType, long contentLength) {
      this.url = BrowserWebOrigin.of(url) == null ? null : url;
      this.fileName = BrowserDownloadPolicy.sanitizeName(fileName);
      String mime = mimeType == null ? "" : mimeType.toLowerCase(Locale.ROOT).trim();
      this.mimeType = BrowserDownloadPolicy.validMime(mime) ? mime : "application/octet-stream";
      this.contentLength = contentLength >= 0 ? contentLength : -1;
      this.pdf = this.mimeType.equals("application/pdf")
          || this.fileName.toLowerCase(Locale.ROOT).endsWith(".pdf");
    }
  }

  /** Text zoom accepted by {@code setTextZoom}, in percent. */
  public static boolean validTextZoom(int percent) {
    return percent >= 50 && percent <= 300;
  }
}
