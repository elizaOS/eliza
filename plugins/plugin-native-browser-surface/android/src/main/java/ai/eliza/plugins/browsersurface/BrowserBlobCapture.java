package ai.eliza.plugins.browsersurface;

import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.webkit.WebView;
import androidx.webkit.JavaScriptExecutionWorld;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.ScriptHandler;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.function.Consumer;
import org.json.JSONObject;

/**
 * Captures a page-created {@code blob:} download of one browser tab into a host-owned file. The
 * script runs in a dedicated isolated JavaScript world: page scripts cannot see its message
 * channel or replace its fetch, and native code accepts only chunks for the one capture it started,
 * from the main frame of the same origin, within {@link BrowserDownloadPolicy#MAX_CAPTURE}. The
 * host reviews the file before saving it anywhere ({@link BrowserDownloads#reviewCaptured}).
 */
public final class BrowserBlobCapture {
  private static final String CHANNEL = "__elizaBrowserCapture";
  private static final String WORLD = "eliza-browser-capture-v1";
  private static final int CHUNK = 384 * 1024;
  /**
   * The isolated-world side: announce the document, then answer one {@code capture} command per
   * nonce with ordered base64 chunks ({@code c}), an end marker with the blob type ({@code e}) or a
   * failure ({@code x}).
   */
  private static final String SCRIPT = "if(window===window.top){const c=" + CHANNEL
      + ";c.addEventListener('message',async e=>{let d;try{d=JSON.parse(String(e.data));}catch(_){return;}"
      + "if(!d||d.t!=='capture'||typeof d.n!=='string'||typeof d.u!=='string')return;"
      + "const n=d.n,p=m=>c.postMessage(m);try{const r=await fetch(d.u);const b=await r.blob();"
      + "if(b.size>" + BrowserDownloadPolicy.MAX_CAPTURE + "){p('x:'+n+':size');return;}let i=0;"
      + "for(let o=0;o<b.size;o+=" + CHUNK + ",i++){const u=new Uint8Array(await b.slice(o,o+" + CHUNK
      + ").arrayBuffer());let s='';for(let j=0;j<u.length;j+=32768)s+=String.fromCharCode.apply(null,u.subarray(j,j+32768));"
      + "p('c:'+n+':'+i+':'+btoa(s));}p('e:'+n+':'+i+':'+(b.type||''));}catch(_){p('x:'+n+':fetch');}});"
      + "c.postMessage('ready');}";

  public interface Done {
    void accept(File file, String mime);
  }

  private final WebView web;
  private final File directory;
  private JavaScriptExecutionWorld world;
  private ScriptHandler script;
  private JavaScriptReplyProxy proxy;
  private String proxyOrigin;
  private String nonce;
  private File file;
  private OutputStream out;
  private long written;
  private int nextChunk;
  private Done done;
  private Consumer<String> failed;
  private boolean closed;
  private final Handler handler = new Handler(Looper.getMainLooper());
  private final Runnable timeout = () -> fail("The page did not provide the file in time.");

  /** Registers the capture world before the tab loads any document. */
  public BrowserBlobCapture(WebView web, File directory) {
    this.web = web;
    this.directory = directory;
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.JS_INJECTION_IN_FRAME_AND_WORLD))
      return;
    try {
      world = WebViewCompat.getExecutionWorld(web, WORLD);
      // The wildcard exists only in this isolated world, never in the page world.
      WebViewCompat.addWebMessageListener(web, CHANNEL, Set.of("*"), world,
          (view, message, source, isMainFrame, reply)
              -> receive(view, message, source.toString(), isMainFrame, reply));
      // Registered before the tab loads any document, so every later main-frame document announces
      // itself. The script fetches only the blob address native code sends on this channel.
      script = WebViewCompat.addJavaScriptOnEvent(web, SCRIPT,
          WebViewCompat.INJECTION_EVENT_DOCUMENT_END, Set.of("*"), world);
    } catch (RuntimeException unavailable) {
      close();
    }
  }

  public boolean supported() {
    return !closed && world != null;
  }

  private void receive(WebView view, WebMessageCompat message, String source, boolean main,
      JavaScriptReplyProxy reply) {
    if (closed || view != web || !main || message.getType() != WebMessageCompat.TYPE_STRING)
      return;
    String data = message.getData(), sender = BrowserWebOrigin.of(source),
           actual = BrowserWebOrigin.of(web.getUrl());
    if (data == null || sender == null || !sender.equals(actual))
      return;
    if ("ready".equals(data)) {
      if (nonce != null && !sender.equals(proxyOrigin))
        fail("The page changed before the file was saved.");
      proxy = reply;
      proxyOrigin = sender;
      return;
    }
    if (nonce == null || reply != proxy || !sender.equals(proxyOrigin))
      return;
    String[] parts = data.split(":", 4);
    if (parts.length < 3 || !nonce.equals(parts[1]))
      return;
    try {
      if ("c".equals(parts[0]) && parts.length == 4) {
        if (Integer.parseInt(parts[2]) != nextChunk) {
          fail("The file was not received in order.");
          return;
        }
        byte[] bytes = Base64.decode(parts[3], Base64.NO_WRAP);
        written += bytes.length;
        nextChunk++;
        if (written > BrowserDownloadPolicy.MAX_CAPTURE) {
          fail("The file is larger than " + (BrowserDownloadPolicy.MAX_CAPTURE / 1048576) + " MB.");
          return;
        }
        out.write(bytes);
        handler.removeCallbacks(timeout);
        handler.postDelayed(timeout, 30000);
      } else if ("e".equals(parts[0]) && parts.length == 4) {
        if (Integer.parseInt(parts[2]) != nextChunk) {
          fail("The file was incomplete.");
          return;
        }
        out.close();
        out = null;
        File result = file;
        Done callback = done;
        String mime = BrowserDownloadPolicy.validMime(parts[3]) ? parts[3].toLowerCase(Locale.ROOT) : null;
        reset(false);
        if (callback != null)
          callback.accept(result, mime);
      } else if ("x".equals(parts[0])) {
        fail("size".equals(parts[2])
                ? "The file is larger than " + (BrowserDownloadPolicy.MAX_CAPTURE / 1048576) + " MB."
                : "The website removed this file before it could be saved. Try the download again.");
      }
    } catch (Exception invalid) {
      fail("The file could not be saved.");
    }
  }

  /** Start capturing one blob URL of the current document's own origin. */
  public void capture(String blobUrl, Done onDone, Consumer<String> onFailure) {
    String owner = BrowserWebOrigin.blobOwner(blobUrl), actual = BrowserWebOrigin.of(web.getUrl());
    if (!supported()) {
      onFailure.accept("This Android System WebView cannot save files created by the page. Update Android System WebView.");
      return;
    }
    if (nonce != null) {
      onFailure.accept("Another file from this page is still being prepared.");
      return;
    }
    if (owner == null || !owner.equals(actual) || proxy == null || !owner.equals(proxyOrigin)
        || blobUrl.length() > 2048 || !blobUrl.matches("(?i)blob:[A-Za-z0-9:/._%\\[\\]-]+")) {
      onFailure.accept("This file could not be saved from this page.");
      return;
    }
    try {
      file = new File(directory, UUID.randomUUID().toString());
      if (!directory.isDirectory() && !directory.mkdirs())
        throw new IllegalStateException();
      out = new FileOutputStream(file);
    } catch (Exception unavailable) {
      reset(true);
      onFailure.accept("The file could not be prepared. Check Android storage and try again.");
      return;
    }
    nonce = UUID.randomUUID().toString().replace("-", "");
    written = 0;
    nextChunk = 0;
    done = onDone;
    failed = onFailure;
    handler.postDelayed(timeout, 30000);
    try {
      proxy.postMessage(new JSONObject().put("t", "capture").put("n", nonce).put("u", blobUrl).toString());
    } catch (Exception unavailable) {
      fail("This file could not be saved from this page.");
    }
  }

  private void fail(String reason) {
    Consumer<String> callback = failed;
    boolean active = nonce != null;
    reset(true);
    if (active && callback != null)
      callback.accept(reason);
  }

  private void reset(boolean delete) {
    handler.removeCallbacks(timeout);
    nonce = null;
    done = null;
    failed = null;
    written = 0;
    nextChunk = 0;
    if (out != null) {
      try {
        out.close();
      } catch (Exception ignored) {
      }
      out = null;
    }
    if (delete && file != null)
      file.delete();
    file = null;
  }

  /** Navigation or tab change: abandon a capture in progress. */
  public void cancel() {
    reset(true);
  }

  public void close() {
    if (closed)
      return;
    closed = true;
    reset(true);
    proxy = null;
    proxyOrigin = null;
    if (script != null) {
      try {
        script.remove();
      } catch (RuntimeException ignored) {
      }
      script = null;
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
