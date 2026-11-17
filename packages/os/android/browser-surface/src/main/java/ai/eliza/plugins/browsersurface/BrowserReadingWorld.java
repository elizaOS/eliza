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
import org.json.JSONArray;
import org.json.JSONTokener;

/**
 * An isolated JavaScript world in which a browser host reads the selected tab's main-frame document
 * (for example {@link BrowserPageReading#EXTRACT}). There is no page-world bridge and no fallback:
 * without {@code JS_INJECTION_IN_FRAME_AND_WORLD} nothing is ever injected and {@link #available}
 * is false, so the host offers no page reading.
 *
 * <p>The world's sole message is readiness, carrying a random id each HTTPS main-frame document
 * draws for itself. Before a host-initiated navigation the host calls {@link #prepare} (or {@link
 * #prepareHistory}); that registers a one-time nonce script for documents loaded afterwards, and
 * when {@link #pageStarted} then reports exactly that address only the reply proxy that posts the
 * nonce is adopted. Any other start (a followed link, a redirect, a page-initiated reload) begins a
 * new generation bound to the started address's origin, and a per-WebView script lets the new
 * document announce itself: only a main-frame ready whose engine-reported origin is that origin and
 * the one the tab shows is adopted. Before {@link #evaluate} runs anything it asks the adopted
 * proxy for its document id and address and requires both to match; a proxy of a replaced
 * document cannot answer, so an ambiguous case reports failure and is never read. A result is
 * delivered only while the same document is still current. The page cannot reach the world's
 * channel or scripts, and native code accepts no command, data or credential from the world.
 *
 * <p>Call every method on the WebView's thread. The host owns which tab is selected, consent, what
 * is read and where the result goes.
 */
public final class BrowserReadingWorld {
  private static final String CHANNEL = "__elizaBrowserReadWorld";
  private static final String WORLD = "eliza-browser-reading-v1";
  /** The world's own per-document id, drawn once by whichever readiness script runs first. */
  private static final String DOCUMENT_ID =
      "(globalThis.__elizaReadingDocument||(Object.defineProperty(globalThis,'__elizaReadingDocument',{value:crypto.randomUUID()}),globalThis.__elizaReadingDocument))";
  private static final String READY = "ready";

  private final WebView web;
  private JavaScriptExecutionWorld world;
  private ScriptHandler script, announce;
  private JavaScriptReplyProxy proxy;
  private String origin, nonce, expectedUrl, expectedOrigin, documentId;
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
                || message.getType() != WebMessageCompat.TYPE_STRING || expectedOrigin == null)
              return;
            String data = message.getData();
            int bar = data == null ? -1 : data.indexOf('|');
            if (bar <= 0 || data.length() - bar - 1 < 1 || data.length() - bar - 1 > 64)
              return;
            // A prepared load answers only with its nonce; any other load only with the shared
            // readiness message.
            String head = data.substring(0, bar);
            if (nonce != null ? !started || !nonce.equals(head) : !READY.equals(head))
              return;
            String actual = origin(web.getUrl()), sender = origin(source.toString());
            if (sender == null || !sender.equals(expectedOrigin) || !sender.equals(actual))
              return;
            proxy = reply;
            origin = sender;
            documentId = data.substring(bar + 1);
          });
      announce = WebViewCompat.addJavaScriptOnEvent(web,
          "if(window===window.top&&location.protocol==='https:'){" + CHANNEL + ".postMessage('" + READY
              + "|'+" + DOCUMENT_ID + ");}",
          WebViewCompat.INJECTION_EVENT_DOCUMENT_END, Set.of("*"), world);
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
          "if(window===window.top&&location.protocol==='https:'){" + CHANNEL + ".postMessage('" + nonce
              + "|'+" + DOCUMENT_ID + ");}",
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
   * The tab started loading {@code url}, which begins a new generation bound to its origin. The one
   * prepared navigation, started once at exactly the prepared address, adopts only its nonce. Any
   * other start (a link, a redirect, a reload the page began) drops the preparation and adopts the
   * new document's own readiness; {@link #evaluate} still checks that document's id and address.
   */
  public void pageStarted(String url) {
    boolean prepared = nonce != null && !started && Objects.equals(expectedUrl, url);
    if (!prepared)
      invalidate();
    generation++;
    proxy = null;
    origin = null;
    documentId = null;
    expectedOrigin = origin(url);
    started = prepared;
  }

  /** Ends the current preparation and any adopted proxy; pending results report failure. */
  public void invalidate() {
    generation++;
    proxy = null;
    origin = null;
    documentId = null;
    nonce = null;
    expectedUrl = null;
    expectedOrigin = null;
    started = false;
    if (script != null) {
      try {
        script.remove();
      } catch (RuntimeException ignored) {
      }
      script = null;
    }
  }

  /** The current document announced itself from the committed HTTPS origin the tab still shows. */
  public boolean ready() {
    return !closed && world != null && proxy != null && origin != null && documentId != null
        && origin.equals(origin(web.getUrl()));
  }

  /**
   * Runs {@code source} in the isolated world of the ready document. The adopted proxy first has to
   * report the adopted document id and the address the tab shows; a proxy of a replaced document
   * cannot answer. {@code result} receives the JSON-encoded value only while that document is still
   * current; otherwise, or on any error, {@code failure} runs. Nothing is ever evaluated in the
   * page's own world, and nothing reloads the page.
   */
  public void evaluate(String source, Consumer<String> result, Runnable failure) {
    if (!ready()) {
      failure.run();
      return;
    }
    long expected = generation;
    JavaScriptReplyProxy selected = proxy;
    String page = web.getUrl(), id = documentId;
    run(selected, "[" + DOCUMENT_ID + ",document.URL]", identity -> {
      if (!current(expected, selected, page) || !sameDocument(identity, id, page)) {
        failure.run();
        return;
      }
      run(selected, source, value -> {
        if (current(expected, selected, page))
          result.accept(value);
        else
          failure.run();
      }, failure);
    }, failure);
  }

  private boolean current(long expected, JavaScriptReplyProxy selected, String page) {
    return expected == generation && selected == proxy && ready() && Objects.equals(page, web.getUrl());
  }

  private static boolean sameDocument(String encoded, String id, String page) {
    try {
      Object decoded = new JSONTokener(encoded).nextValue();
      if (!(decoded instanceof JSONArray) || ((JSONArray) decoded).length() != 2)
        return false;
      JSONArray identity = (JSONArray) decoded;
      return id.equals(identity.getString(0)) && Objects.equals(page, identity.getString(1));
    } catch (Exception invalid) {
      return false;
    }
  }

  private static void run(JavaScriptReplyProxy selected, String source, Consumer<String> result,
      Runnable failure) {
    try {
      selected.executeJavaScript(source,
          new WebViewOutcomeReceiver<String, JavaScriptExecutionException>() {
            @Override
            public void onResult(String value) {
              result.accept(value);
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
    if (announce != null) {
      try {
        announce.remove();
      } catch (RuntimeException ignored) {
      }
      announce = null;
    }
    if (world != null) {
      try {
        WebViewCompat.removeWebMessageListener(web, world, CHANNEL);
      } catch (RuntimeException ignored) {
      }
      world = null;
    }
  }
}
