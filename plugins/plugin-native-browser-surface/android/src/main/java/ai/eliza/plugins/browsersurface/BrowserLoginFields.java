package ai.eliza.plugins.browsersurface;

import android.content.Context;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.util.SparseArray;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewStructure;
import android.view.autofill.AutofillId;
import android.view.autofill.AutofillManager;
import android.view.autofill.AutofillValue;
import android.webkit.WebView;
import androidx.annotation.RequiresApi;
import androidx.webkit.JavaScriptExecutionWorld;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.ScriptHandler;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.util.Set;
import org.json.JSONObject;

/**
 * Engine-attested login fields for one browser tab: the native adapter a password provider needs
 * to fill or save a website login in an embedded WebView, giving every login field a per-field
 * origin ({@link BrowserAutofillExtras#fieldOrigin}) that the browser engine reported.
 *
 * <p>The reporter ({@link #SCRIPT}) runs at document start in every frame, in an isolated
 * JavaScript world page script cannot reach, and reports focused username/password fields over a {@code WebMessageListener}. The
 * listener's {@code sourceOrigin} and {@code isMainFrame} come from WebView; {@link
 * BrowserFieldOrigin#bind} accepts only a committed HTTPS origin equal to the tab's committed
 * top-level origin. Admitted fields appear to Android Autofill as virtual children of {@link
 * Anchor}, a transparent, non-interactive view the host lays over the tab; the host excludes the
 * tab WebView's own structure while this adapter exists, so no field is offered twice. The
 * selected provider owns unlock, choice and save. Values it fills are posted only to the reply
 * proxy of the frame that reported the field.
 *
 * <p>Nothing here logs, stores or forwards a value: fill values go from the framework to that
 * frame; submitted values go from that frame to the framework session for the provider's Save.
 */
@RequiresApi(Build.VERSION_CODES.O)
public final class BrowserLoginFields {
  public static final String CHANNEL = "__elizaLoginFields";
  private static final String WORLD = "eliza-browser-login-v1";
  /** Virtual ids advance per binding, so values for an earlier binding never match a newer one. */
  private static final int SPAN = 4;

  /**
   * The reporter, run at document start in every frame of the isolated world. It tells native code
   * which focused field of its own frame is a username or password field and never reports an
   * origin, URL or frame; fill values arrive only on its own frame's channel and are written only
   * into a field it registered in its own document.
   */
  static final String SCRIPT = """
    (() => {
      'use strict';
      const channel = globalThis.__elizaLoginFields;
      if (!channel || typeof channel.postMessage !== 'function') return;
      if (location.protocol !== 'https:' || !globalThis.isSecureContext) return;

      const bytes = new Uint8Array(12);
      crypto.getRandomValues(bytes);
      const documentId = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      const keys = new WeakMap();
      const fields = new Map();
      let nextKey = 1;
      let reported = null;

      const tokens = el => String(el.getAttribute('autocomplete') || '').toLowerCase().split(/\\s+/).filter(Boolean);
      const textual = el => el instanceof HTMLInputElement && (el.type === 'text' || el.type === 'email' || el.type === 'tel');
      const usable = el => el instanceof HTMLInputElement && el.isConnected && !el.disabled && !el.readOnly && el.getClientRects().length > 0;
      const keyOf = el => {
        let key = keys.get(el);
        if (!key) {
          if (nextKey > 100000) return 0;
          key = nextKey++;
          keys.set(el, key);
          fields.set(key, new WeakRef(el));
        }
        return key;
      };
      const field = key => {
        const el = key ? fields.get(key)?.deref() : null;
        return el && usable(el) ? el : null;
      };

      /** Login fields of the form (or root) that owns {@code target}: exactly one password field. */
      function login(target) {
        if (!(target instanceof HTMLInputElement)) return null;
        const scope = target.form ? Array.from(target.form.elements) : Array.from(target.getRootNode().querySelectorAll('input'));
        const inputs = scope.filter(usable);
        const passwords = inputs.filter(el => el.type === 'password');
        if (passwords.length !== 1) return null;
        const password = passwords[0];
        let username = inputs.find(el => textual(el) && tokens(el).some(t => t === 'username' || t === 'email')) || null;
        if (!username) {
          for (let i = inputs.indexOf(password) - 1; i >= 0; i--) if (textual(inputs[i])) { username = inputs[i]; break; }
        }
        if (target !== password && target !== username) return null;
        return { username, password };
      }

      /**
       * Field box in the top-level viewport. Only computed through same-origin ancestors; when an
       * ancestor is another site's frame the field is not reported at all (native refuses it too).
       */
      function box(el) {
        const rect = el.getBoundingClientRect();
        let x = rect.left, y = rect.top, w = window;
        while (w !== w.top) {
          let frame;
          try { frame = w.frameElement; } catch { return null; }
          if (!frame) return null;
          const outer = frame.getBoundingClientRect();
          x += outer.left + frame.clientLeft;
          y += outer.top + frame.clientTop;
          w = w.parent;
        }
        return [x, y, rect.width, rect.height, w.innerWidth];
      }
      const number = n => Math.max(-99999, Math.min(999999, Number.isFinite(n) ? n : 0)).toFixed(3).replace(/\\.?0+$/, '') || '0';
      const send = message => { try { channel.postMessage(message); } catch { /* channel gone with the document */ } };

      document.addEventListener('focusin', event => {
        if (!event.isTrusted) return;
        const target = event.composedPath()[0];
        const found = login(target);
        const where = found && box(target);
        if (!found || !where) { if (reported) { reported = null; send(`blur|${documentId}`); } return; }
        const u = found.username ? keyOf(found.username) : 0, p = keyOf(found.password);
        const focused = target === found.password ? p : u;
        if (!p || !focused) { if (reported) { reported = null; send(`blur|${documentId}`); } return; }
        const ua = found.username ? (tokens(found.username).find(t => t === 'username' || t === 'email') || '') : '';
        const pa = tokens(found.password).find(t => t === 'current-password' || t === 'new-password') || '';
        reported = { u, p };
        send(`focus|${documentId}|${focused}|${u}|${p}|${ua}|${pa}|${where.map(number).join(',')}`);
      }, true);

      document.addEventListener('focusout', event => {
        if (!event.isTrusted || !reported) return;
        reported = null;
        send(`blur|${documentId}`);
      }, true);

      // The document is unloading (a frame navigating on its own included): native ends the binding.
      addEventListener('pagehide', () => { reported = null; send(`gone|${documentId}`); }, true);

      // Save: values of fields registered by a focus report, on a real submit of their own form.
      document.addEventListener('submit', event => {
        if (!event.isTrusted) return;
        const form = event.target;
        if (!(form instanceof HTMLFormElement)) return;
        const inputs = Array.from(form.elements).filter(usable);
        const password = inputs.find(el => el.type === 'password' && keys.has(el) && el.value);
        if (!password) return;
        const found = login(password);
        if (!found) return;
        const u = found.username && keys.has(found.username) ? keys.get(found.username) : 0;
        const username = u ? found.username.value : '';
        if (password.value.length > 1024 || username.length > 1024) return;
        let encoded;
        try { encoded = [encodeURIComponent(username), encodeURIComponent(password.value)]; } catch { return; }
        send(`submit|${documentId}|${u}|${keys.get(password)}|${encoded[0]}|${encoded[1]}`);
      }, true);

      // Fill: only this frame's channel delivers it; the address check is a second guard against a
      // document that replaced this one. Unknown or detached fields are ignored.
      channel.addEventListener('message', event => {
        let data;
        try { data = JSON.parse(String(event.data)); } catch { return; }
        if (!data || data.t !== 'fill' || data.d !== documentId || data.o !== location.origin) return;
        const targets = [[data.u, data.uv], [data.p, data.pv]];
        for (const [key, value] of targets) {
          if (typeof value !== 'string' || !Number.isInteger(key)) continue;
          const el = field(key);
          if (!el) continue;
          valueSetter.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        data = null;
      });
    })();
    """;

  /** The tab as the browser host sees it now (selection, visibility, navigation, committed URL). */
  public interface Host {
    BrowserFieldOrigin.TabSnapshot snapshot();
  }

  /**
   * Whether this WebView provider can attest field origins: engine-supplied message origins and
   * scripts in an isolated world, in every frame. Without both, fill stays off.
   */
  public static boolean supported() {
    try {
      return WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
          && WebViewFeature.isFeatureSupported(WebViewFeature.JS_INJECTION_IN_FRAME_AND_WORLD);
    } catch (RuntimeException | LinkageError unavailable) {
      return false;
    }
  }

  private final WebView web;
  private final Host host;
  private final BrowserAutofillExtras extras;
  public final Anchor anchor;
  private JavaScriptExecutionWorld world;
  private ScriptHandler script;
  private boolean closed;
  private BrowserFieldOrigin.Binding binding;
  /** The latest focus report of the bound fields: which of them is focused, and where. */
  private BrowserFieldOrigin.Report focus;
  private JavaScriptReplyProxy proxy;
  /** A field focused before the tab was eligible, and its frame's reply proxy. */
  private BrowserFieldOrigin.Deferred deferred;
  private JavaScriptReplyProxy deferredProxy;
  private int base = 0;

  private BrowserLoginFields(WebView web, Host host, BrowserAutofillExtras extras) {
    this.web = web;
    this.host = host;
    this.extras = extras;
    this.anchor = new Anchor(web.getContext());
  }

  /**
   * Installs the listener and reporter before the tab loads anything (WebView applies both only to
   * documents loaded afterwards). Returns null when unsupported or when setup fails; the host then
   * keeps fill off for providers that require per-field origins.
   */
  public static BrowserLoginFields install(WebView web, Host host, BrowserAutofillExtras extras) {
    if (extras == null || !supported())
      return null;
    BrowserLoginFields fields = new BrowserLoginFields(web, host, extras);
    try {
      fields.world = WebViewCompat.getExecutionWorld(web, WORLD);
      // "*" only makes the channel exist in every frame of this isolated world; whether a frame
      // may be filled is decided natively from the engine's sourceOrigin, never from this rule.
      WebViewCompat.addWebMessageListener(web, CHANNEL, Set.of("*"), fields.world, fields::onPostMessage);
      fields.script = WebViewCompat.addJavaScriptOnEvent(web, SCRIPT,
          WebViewCompat.INJECTION_EVENT_DOCUMENT_START, Set.of("*"), fields.world);
      return fields;
    } catch (Exception | LinkageError unavailable) {
      fields.close();
      return null;
    }
  }

  private void onPostMessage(WebView view, WebMessageCompat message, Uri sourceOrigin,
      boolean isMainFrame, JavaScriptReplyProxy reply) {
    if (closed || view != web || message == null || message.getType() != WebMessageCompat.TYPE_STRING)
      return;
    BrowserFieldOrigin.Report report = BrowserFieldOrigin.Report.parse(message.getData());
    if (report == null)
      return;
    BrowserFieldOrigin.TabSnapshot now = host.snapshot();
    // The only origin source: what WebView reported for the posting frame.
    BrowserFieldOrigin.EngineSource engine = new BrowserFieldOrigin.EngineSource(
        sourceOrigin == null ? null : sourceOrigin.toString(), isMainFrame);
    switch (report.kind) {
      case FOCUS:
        focus(engine, report, reply, now);
        return;
      case BLUR:
        if (deferred != null && deferred.sameFrame(engine, report))
          forget();
        if (binding != null && binding.sameFrame(engine, report))
          exit();
        return;
      case GONE:
        // The bound document is unloading (including a frame navigating on its own).
        if (deferred != null && deferred.sameFrame(engine, report))
          forget();
        if (binding != null && binding.sameFrame(engine, report))
          revoke(true);
        return;
      case SUBMIT:
        if (binding == null || !binding.sameFrame(engine, report) || !binding.admits(now))
          return;
        if (report.password != binding.fields.password
            || (report.username != 0 && report.username != binding.fields.username))
          return;
        AutofillManager manager = manager();
        if (manager == null)
          return;
        if (report.username != 0)
          manager.notifyValueChanged(anchor, base + 1, AutofillValue.forText(report.usernameValue));
        manager.notifyValueChanged(anchor, base + 2, AutofillValue.forText(report.passwordValue));
    }
  }

  /** A focus report from the engine-attested frame {@code engine}, judged against the tab {@code now}. */
  private void focus(BrowserFieldOrigin.EngineSource engine, BrowserFieldOrigin.Report report,
      JavaScriptReplyProxy reply, BrowserFieldOrigin.TabSnapshot now) {
    // A newer focus replaces any field still waiting for the tab to become eligible.
    forget();
    BrowserFieldOrigin.Decision decision = BrowserFieldOrigin.bind(engine, now);
    // Re-focus of the same fields (switching between them, or returning from a provider's unlock
    // screen) keeps the binding and its virtual ids, so a pending fill result still matches.
    if (binding != null && binding.sameFields(engine, report)) {
      focus = report;
      if (decision.fillable())
        enter(report);
      return;
    }
    // Focus moved to other fields: any earlier binding ends, including when the new field is refused.
    revoke(true);
    // Focus that arrived while the page was still loading (autofocus) or a prompt was open is
    // kept for this navigation and judged again, in full, when the tab becomes eligible.
    deferred = BrowserFieldOrigin.Deferred.of(engine, report, now, decision);
    deferredProxy = deferred == null ? null : reply;
    if (!decision.fillable())
      return;
    binding = new BrowserFieldOrigin.Binding(decision.origin, now.navigation, report);
    proxy = reply;
    focus = report;
    base = (base + SPAN) % 0x3ffffff0;
    enter(report);
  }

  private void forget() {
    deferred = null;
    deferredProxy = null;
  }

  /**
   * Called by the host whenever the tab may have become eligible (page finished, prompt closed,
   * resumed, shown). A field focused before then is offered now, through the same {@link
   * BrowserFieldOrigin#bind} decision; one from an earlier navigation is dropped.
   */
  public void retry() {
    BrowserFieldOrigin.Deferred pending = deferred;
    JavaScriptReplyProxy reply = deferredProxy;
    if (closed || pending == null || reply == null || binding != null)
      return;
    BrowserFieldOrigin.TabSnapshot now = host.snapshot();
    if (!pending.current(now)) {
      forget();
      return;
    }
    // Still not eligible: keep waiting without ending anything.
    BrowserFieldOrigin.Decision decision = BrowserFieldOrigin.bind(pending.engine, now);
    if (!decision.fillable() && BrowserFieldOrigin.HIDDEN.equals(decision.refusal))
      return;
    focus(pending.engine, pending.report, reply, now);
  }

  private AutofillManager manager() {
    return web.getContext().getSystemService(AutofillManager.class);
  }

  private boolean admitted() {
    BrowserFieldOrigin.Binding current = binding;
    return !closed && current != null && proxy != null && current.admits(host.snapshot());
  }

  private int focusedId(BrowserFieldOrigin.Report report) {
    return base + (report.focused == report.password ? 2 : 1);
  }

  private void enter(BrowserFieldOrigin.Report report) {
    AutofillManager manager = manager();
    if (manager == null || !admitted())
      return;
    manager.notifyViewEntered(anchor, focusedId(report), screenBounds(report));
  }

  private void exit() {
    AutofillManager manager = manager();
    if (manager != null && binding != null && focus != null)
      manager.notifyViewExited(anchor, focusedId(focus));
  }

  /**
   * Ends the current binding. With {@code exit}, the focused field is exited so its popup closes.
   * Fields are never reported invisible here: a provider that saves when all fields disappear
   * would turn a cancel path into a Save offer. Callers that cancel do so with {@code
   * AutofillManager#cancel}; a committed session needs nothing more.
   */
  public void revoke(boolean exit) {
    BrowserFieldOrigin.Binding old = binding;
    BrowserFieldOrigin.Report focused = focus;
    binding = null;
    proxy = null;
    focus = null;
    if (old == null)
      return;
    old.revoke();
    AutofillManager manager = manager();
    if (exit && manager != null)
      manager.notifyViewExited(anchor, focusedId(focused == null ? old.fields : focused));
  }

  public void close() {
    if (closed)
      return;
    revoke(true);
    forget();
    closed = true;
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

  /** Screen rectangle of the focused field, for the framework popup. Page geometry only positions UI. */
  private Rect screenBounds(BrowserFieldOrigin.Report report) {
    int[] location = new int[2];
    anchor.getLocationOnScreen(location);
    float scale = report.viewportWidth > 0 && anchor.getWidth() > 0
        ? anchor.getWidth() / report.viewportWidth
        : anchor.getResources().getDisplayMetrics().density;
    int left = clamp(Math.round(report.x * scale), anchor.getWidth());
    int top = clamp(Math.round(report.y * scale), anchor.getHeight());
    int right = clamp(Math.round((report.x + report.width) * scale), anchor.getWidth());
    int bottom = clamp(Math.round((report.y + report.height) * scale), anchor.getHeight());
    return new Rect(location[0] + left, location[1] + top, location[0] + Math.max(left, right),
        location[1] + Math.max(top, bottom));
  }

  private static int clamp(int value, int max) {
    return Math.max(0, Math.min(Math.max(0, max), value));
  }

  private void fill(SparseArray<AutofillValue> values) {
    BrowserFieldOrigin.Binding current = binding;
    JavaScriptReplyProxy target = proxy;
    if (values == null || target == null || !admitted())
      return;
    String username = text(values.get(base + 1)), password = text(values.get(base + 2));
    if (username == null && password == null)
      return;
    try {
      JSONObject message = new JSONObject();
      message.put("t", "fill").put("d", current.document).put("o", current.origin);
      if (username != null && current.fields.username != 0) {
        message.put("u", current.fields.username);
        message.put("uv", username);
      }
      if (password != null) {
        message.put("p", current.fields.password);
        message.put("pv", password);
      }
      target.postMessage(message.toString());
    } catch (Exception dropped) {
      // The frame is gone; nothing is retried or recorded.
    }
  }

  private static String text(AutofillValue value) {
    return value != null && value.isText() ? value.getTextValue().toString() : null;
  }

  /**
   * The tab's login fields as Android Autofill sees them: a transparent view over the WebView that
   * never draws, takes focus or touches, and exposes children only while bound.
   */
  public final class Anchor extends View {
    Anchor(Context context) {
      super(context);
      setFocusable(false);
      setClickable(false);
      setLongClickable(false);
      setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
    }

    @Override
    public boolean onTouchEvent(MotionEvent event) {
      return false;
    }

    @Override
    public int getImportantForAutofill() {
      return admitted() ? View.IMPORTANT_FOR_AUTOFILL_YES
                        : View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS;
    }

    @Override
    public void onProvideAutofillVirtualStructure(ViewStructure structure, int flags) {
      BrowserFieldOrigin.Binding current = binding;
      if (current == null || !admitted()) {
        structure.setChildCount(0);
        return;
      }
      BrowserFieldOrigin.Report fields = current.fields;
      // The committed top-level origin, as the tab WebView reports it, for the provider's host check.
      String top = BrowserFieldOrigin.exactHttps(host.snapshot().state.documentUrl);
      structure.setWebDomain(current.origin);
      Bundle bundle = structure.getExtras();
      if (top != null && bundle != null)
        bundle.putString(extras.topOrigin, top);
      boolean user = fields.username != 0;
      structure.setChildCount(user ? 2 : 1);
      AutofillId parent = structure.getAutofillId();
      int index = 0;
      BrowserFieldOrigin.Report focused = focus == null ? fields : focus;
      if (user)
        child(structure.newChild(index++), parent, base + 1, current.origin, false,
            fields.usernameAutocomplete, focused.focused == fields.username);
      child(structure.newChild(index), parent, base + 2, current.origin, true,
          fields.passwordAutocomplete, focused.focused == fields.password);
    }

    /** One virtual field. Its origin is the binding's engine-reported frame origin, never the top-level URL. */
    private void child(ViewStructure child, AutofillId parent, int id, String origin,
        boolean password, String autocomplete, boolean focused) {
      child.setAutofillId(parent, id);
      child.setAutofillType(View.AUTOFILL_TYPE_TEXT);
      child.setAutofillHints(
          new String[] {password ? View.AUTOFILL_HINT_PASSWORD : View.AUTOFILL_HINT_USERNAME});
      child.setInputType(InputType.TYPE_CLASS_TEXT
          | (password ? InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD
                      : InputType.TYPE_TEXT_VARIATION_WEB_EMAIL_ADDRESS));
      ViewStructure.HtmlInfo.Builder html =
          child.newHtmlInfoBuilder("input").addAttribute("type", password ? "password" : "text");
      if (!autocomplete.isEmpty())
        html.addAttribute("autocomplete", autocomplete);
      child.setHtmlInfo(html.build());
      child.setWebDomain(origin);
      child.setVisibility(View.VISIBLE);
      child.setFocused(focused);
      child.setDataIsSensitive(true);
      child.setClassName("android.widget.EditText");
      Bundle bundle = child.getExtras();
      if (bundle != null)
        bundle.putString(extras.fieldOrigin, origin);
    }

    @Override
    public void autofill(SparseArray<AutofillValue> values) {
      fill(values);
    }
  }
}
