package ai.eliza.plugins.browsersurface;

import android.net.Uri;
import android.webkit.WebBackForwardList;
import android.webkit.WebView;
import androidx.webkit.JavaScriptExecutionException;
import androidx.webkit.JavaScriptExecutionWorld;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.ScriptHandler;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import androidx.webkit.WebViewOutcomeReceiver;
import java.util.Locale;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.function.Consumer;

/**
 * An isolated JavaScript world in which a browser host reads the selected tab's main-frame document
 * (for example {@link BrowserPageReading#EXTRACT}). There is no page-world bridge and no fallback:
 * without {@code JS_INJECTION_IN_FRAME_AND_WORLD} nothing is ever injected and {@link #available}
 * is false, so the host offers no page reading.
 *
 * <p>The world's sole message is readiness. Before each navigation the host calls {@link #prepare}
 * (or {@link #prepareHistory}); that registers a one-time nonce script for documents loaded
 * afterwards. {@link #pageStarted} must then report exactly that address, and only the main frame's
 * reply proxy that posts the nonce from the committed HTTPS origin is adopted. A redirect, reload or
 * any unprepared navigation invalidates the world until the host prepares again. {@link #evaluate}
 * runs only through that proxy, and delivers a result only while the same document is still
 * current; anything else reports failure. The page cannot reach the world's channel or script, and
 * native code accepts no command, data or credential from the world.
 *
 * <p>Call every method on the WebView's thread. The host owns which tab is selected, consent, what
 * is read and where the result goes.
 */
public final class BrowserReadingWorld {
  private static final String CHANNEL = "__elizaBrowserReadWorld";
  private static final String WORLD = "eliza-browser-reading-v1";

  private final WebView web;
  private JavaScriptExecutionWorld world;
  private ScriptHandler script;
  private JavaScriptReplyProxy proxy;
  private String origin, nonce, expectedUrl;
  private boolean started;
  private long generation;
  private boolean closed;

  /** Registers the world's listener; without the capability nothing is created. */
  public BrowserReadingWorld(WebView web) {
    this.web = web;
    if (!supported())
      return;
    try {
      world = WebViewCompat.getExecutionWorld(web, WORLD);
      // Browsing accepts arbitrary origins. The wildcard exists ONLY in this isolated world, never
      // in the page world; native code accepts no command, data or credentials from it, and
      // excludes all non-main-frame messages.
      WebViewCompat.addWebMessageListener(web, CHANNEL, Set.of("*"), world,
          (view, message, source, isMainFrame, reply) -> {
            if (closed || view != web || !isMainFrame
                || message.getType() != WebMessageCompat.TYPE_STRING || nonce == null || !started
                || !nonce.equals(message.getData()))
              return;
            String actual = origin(web.getUrl()), sender = origin(source.toString());
            if (actual == null || !actual.equals(sender))
              return;
            proxy = reply;
            origin = sender;
          });
    } catch (RuntimeException unavailable) {
      close();
    }
  }

  /**
   * Whether this WebView provider can run a script in a world the page's own script cannot reach.
   * Without it there is no page reading at all: nothing is ever injected into the page's world.
   */
  public static boolean supported() {
    try {
      return WebViewFeature.isFeatureSupported(WebViewFeature.JS_INJECTION_IN_FRAME_AND_WORLD);
    } catch (RuntimeException | LinkageError unavailable) {
      return false;
    }
  }

  /** False when the provider lacks the capability or the isolated world could not be set up. */
  public boolean available() {
    return !closed && world != null;
  }

  private static String origin(String value) {
    if (value == null)
      return null;
    try {
      Uri uri = Uri.parse(value);
      String host = uri.getHost();
      if (!"https".equalsIgnoreCase(uri.getScheme()) || host == null || uri.getUserInfo() != null)
        return null;
      return "https://" + host.toLowerCase(Locale.ROOT) + ":" + (uri.getPort() < 0 ? 443 : uri.getPort());
    } catch (Exception invalid) {
      return null;
    }
  }

  /**
   * Prepares the world for a navigation to {@code url}. Must run before loadUrl, reload or a
   * history navigation, never from onPageStarted: WebView only guarantees registration for
   * documents loaded after this call. A non-HTTPS address leaves the world unprepared.
   */
  public void prepare(String url) {
    invalidate();
    if (closed || world == null || origin(url) == null)
      return;
    nonce = UUID.randomUUID().toString();
    expectedUrl = url;
    try {
      script = WebViewCompat.addJavaScriptOnEvent(web,
          "if(window===window.top&&location.protocol==='https:'){" + CHANNEL + ".postMessage('" + nonce + "');}",
          WebViewCompat.INJECTION_EVENT_DOCUMENT_END, Set.of("*"), world);
    } catch (RuntimeException unavailable) {
      invalidate();
    }
  }

  /** {@link #prepare} for the history entry {@code offset} steps from the current one. */
  public void prepareHistory(int offset) {
    WebBackForwardList history = web.copyBackForwardList();
    int index = history.getCurrentIndex() + offset;
    prepare(index >= 0 && index < history.getSize() ? history.getItemAtIndex(index).getUrl() : null);
  }

  /**
   * The tab started loading {@code url}. Only the one prepared navigation, started once at exactly
   * the prepared address, may later adopt a proxy. A repeated or unprepared start may be a redirect
   * or a same-origin reload and is never adopted on an origin-only claim; the host prepares again
   * (for example on an explicit Reload).
   */
  public void pageStarted(String url) {
    if (nonce == null || started || !Objects.equals(expectedUrl, url)) {
      invalidate();
      return;
    }
    generation++;
    proxy = null;
    origin = null;
    started = true;
  }

  /** Ends the current preparation and any adopted proxy; pending results report failure. */
  public void invalidate() {
    generation++;
    proxy = null;
    origin = null;
    nonce = null;
    expectedUrl = null;
    started = false;
    if (script != null) {
      try {
        script.remove();
      } catch (RuntimeException ignored) {
      }
      script = null;
    }
  }

  /** The prepared document announced itself from the committed HTTPS origin the tab still shows. */
  public boolean ready() {
    return !closed && world != null && proxy != null && origin != null
        && origin.equals(origin(web.getUrl()));
  }

  /**
   * Runs {@code source} in the isolated world of the ready document. {@code result} receives its
   * JSON-encoded value only while that document is still current; otherwise, or on any error,
   * {@code failure} runs. Nothing is ever evaluated in the page's own world.
   */
  public void evaluate(String source, Consumer<String> result, Runnable failure) {
    if (!ready()) {
      failure.run();
      return;
    }
    long expected = generation;
    JavaScriptReplyProxy selected = proxy;
    String page = web.getUrl();
    try {
      selected.executeJavaScript(source,
          new WebViewOutcomeReceiver<String, JavaScriptExecutionException>() {
            @Override
            public void onResult(String value) {
              if (expected == generation && selected == proxy && ready()
                  && Objects.equals(page, web.getUrl()))
                result.accept(value);
              else
                failure.run();
            }

            @Override
            public void onError(JavaScriptExecutionException error) {
              failure.run();
            }
          });
    } catch (RuntimeException unavailable) {
      failure.run();
    }
  }

  /** Removes the script and listener; the world is unavailable afterwards. */
  public void close() {
    if (closed)
      return;
    closed = true;
    invalidate();
    if (world != null) {
      try {
        WebViewCompat.removeWebMessageListener(web, world, CHANNEL);
      } catch (RuntimeException ignored) {
      }
      world = null;
    }
  }
}
