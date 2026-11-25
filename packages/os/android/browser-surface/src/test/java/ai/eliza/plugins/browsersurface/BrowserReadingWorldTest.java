package ai.eliza.plugins.browsersurface;

import static org.junit.Assert.*;

import android.content.Context;
import android.graphics.Bitmap;
import android.webkit.WebBackForwardList;
import android.webkit.WebHistoryItem;
import android.webkit.WebView;
import androidx.appcompat.app.AppCompatActivity;
import androidx.webkit.JavaScriptExecutionException;
import androidx.webkit.JavaScriptExecutionWorld;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.ScriptHandler;
import androidx.webkit.WebViewOutcomeReceiver;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.util.ReflectionHelpers;

/** Verifies BrowserReadingWorld keeps a ready document across same-document history navigation. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 29, manifest = Config.NONE)
public final class BrowserReadingWorldTest {
  private static final class HistoryItem extends WebHistoryItem {
    private final String url;
    HistoryItem(String url) { this.url = url; }
    @Override public String getUrl() { return url; }
    @Override public String getOriginalUrl() { return url; }
    @Override public String getTitle() { return url; }
    @Override public Bitmap getFavicon() { return null; }
    @Override protected WebHistoryItem clone() { return new HistoryItem(url); }
  }

  private static final class HistoryList extends WebBackForwardList {
    private final List<HistoryItem> items;
    private final int current;
    HistoryList(List<String> urls, int current) {
      this.items = new ArrayList<>();
      for (String u : urls) this.items.add(new HistoryItem(u));
      this.current = current;
    }
    @Override public WebHistoryItem getCurrentItem() { return current >= 0 && current < items.size() ? items.get(current) : null; }
    @Override public int getCurrentIndex() { return current; }
    @Override public WebHistoryItem getItemAtIndex(int index) { return items.get(index); }
    @Override public int getSize() { return items.size(); }
    @Override protected WebBackForwardList clone() { return this; }
  }

  private static final class HistoryWebView extends WebView {
    String shownUrl;
    WebBackForwardList history;
    HistoryWebView(Context context, String shownUrl, WebBackForwardList history) {
      super(context);
      this.shownUrl = shownUrl;
      this.history = history;
    }
    @Override public String getUrl() { return shownUrl; }
    @Override public WebBackForwardList copyBackForwardList() { return history; }
  }

  private static BrowserReadingWorld readyWorld(HistoryWebView web, String origin, String docId,
      List<String> scripts, List<Boolean> removed) {
    BrowserReadingWorld world = new BrowserReadingWorld(web);
    JavaScriptExecutionWorld fakeWorld = new JavaScriptExecutionWorld("eliza-browser-reading-v1", web);
    JavaScriptReplyProxy fakeProxy = new JavaScriptReplyProxy() {
      @Override public void postMessage(String message) {}
      @Override public void postMessage(byte[] arrayBuffer) {}
      @Override public void executeJavaScript(String javaScript,
          WebViewOutcomeReceiver<String, JavaScriptExecutionException> receiver) {
        if (javaScript.contains("document.URL")) {
          receiver.onResult("[\"" + docId + "\",\"" + web.shownUrl + "\"]");
        } else {
          receiver.onResult("\"excerpt-body\"");
        }
      }
    };
    ReflectionHelpers.setField(world, "world", fakeWorld);
    ReflectionHelpers.setField(world, "proxy", fakeProxy);
    ReflectionHelpers.setField(world, "origin", origin);
    ReflectionHelpers.setField(world, "expectedOrigin", origin);
    ReflectionHelpers.setField(world, "documentId", docId);
    world.documentEndRegistrar = js -> {
      scripts.add(js);
      return () -> removed.add(Boolean.TRUE);
    };
    return world;
  }

  @Test public void sameOriginHistoryBackKeepsReadingReadyUntilPageStarts() {
    AppCompatActivity activity = Robolectric.buildActivity(AppCompatActivity.class).get();
    HistoryList history = new HistoryList(
        List.of("https://example.com/article", "https://example.com/article#comments"), 1);
    HistoryWebView web = new HistoryWebView(activity, "https://example.com/article#comments", history);
    List<String> scripts = new ArrayList<>();
    List<Boolean> removed = new ArrayList<>();
    try {
      BrowserReadingWorld world = readyWorld(web, "https://example.com:443", "doc-1", scripts, removed);
      assertTrue(world.ready());

      // Same-document Back: no onPageStarted fires; the tab's URL moves to the earlier fragment/path.
      world.prepareHistory(-1);
      web.shownUrl = "https://example.com/article";
      assertTrue("same-document back keeps world ready", world.ready());
      assertEquals("doc-1", ReflectionHelpers.getField(world, "documentId"));
      assertEquals("https://example.com/article", ReflectionHelpers.getField(world, "expectedUrl"));
      assertEquals(1, scripts.size());
      assertFalse(ReflectionHelpers.<Boolean>getField(world, "started"));

      AtomicReference<String> read = new AtomicReference<>();
      AtomicReference<Boolean> failed = new AtomicReference<>(Boolean.FALSE);
      world.evaluate("extract()", read::set, () -> failed.set(Boolean.TRUE));
      assertEquals("\"excerpt-body\"", read.get());
      assertEquals(Boolean.FALSE, failed.get());

      // If a cross-document navigation actually starts to that prepared URL, readiness clears immediately
      // and the prepared nonce is adopted (old proxy dropped).
      world.pageStarted("https://example.com/article");
      assertFalse("cross-document pageStarted clears previous proxy", world.ready());
      assertTrue(ReflectionHelpers.<Boolean>getField(world, "started"));
      assertNotNull(ReflectionHelpers.getField(world, "nonce"));
      AtomicReference<Boolean> failedAfterStart = new AtomicReference<>(Boolean.FALSE);
      world.evaluate("extract()", v -> fail("must not read after pageStarted"), () -> failedAfterStart.set(Boolean.TRUE));
      assertEquals(Boolean.TRUE, failedAfterStart.get());
    } finally {
      web.destroy();
    }
  }

  @Test public void crossOriginOrInsecureHistoryBackInvalidatesImmediately() {
    AppCompatActivity activity = Robolectric.buildActivity(AppCompatActivity.class).get();
    for (String target : new String[] {"https://other.example/page", "http://example.com/page"}) {
      HistoryList history = new HistoryList(List.of(target, "https://example.com/article"), 1);
      HistoryWebView web = new HistoryWebView(activity, "https://example.com/article", history);
      List<String> scripts = new ArrayList<>();
      List<Boolean> removed = new ArrayList<>();
      try {
        BrowserReadingWorld world = readyWorld(web, "https://example.com:443", "doc-1", scripts, removed);
        assertTrue(world.ready());
        world.prepareHistory(-1);
        assertFalse(target, world.ready());
        assertNull(target, ReflectionHelpers.getField(world, "proxy"));
        assertNull(target, ReflectionHelpers.getField(world, "documentId"));
      } finally {
        web.destroy();
      }
    }
  }

  @Test public void registrarFailureDuringSameOriginHistoryBackFailsClosed() {
    AppCompatActivity activity = Robolectric.buildActivity(AppCompatActivity.class).get();
    HistoryList history = new HistoryList(
        List.of("https://example.com/article", "https://example.com/article#top"), 1);
    HistoryWebView web = new HistoryWebView(activity, "https://example.com/article#top", history);
    try {
      BrowserReadingWorld world = readyWorld(web, "https://example.com:443", "doc-1", new ArrayList<>(), new ArrayList<>());
      world.documentEndRegistrar = js -> { throw new RuntimeException("webview unavailable"); };
      world.prepareHistory(-1);
      assertFalse("registrar error must fail closed", world.ready());
      assertNull(ReflectionHelpers.getField(world, "proxy"));
    } finally {
      web.destroy();
    }
  }
}
