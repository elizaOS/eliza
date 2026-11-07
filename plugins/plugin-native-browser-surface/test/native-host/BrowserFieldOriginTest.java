import ai.eliza.plugins.browsersurface.BrowserAutofillEligibility;
import ai.eliza.plugins.browsersurface.BrowserFieldOrigin;
import ai.eliza.plugins.passwords.PasswordFormPolicy;
import ai.eliza.plugins.passwords.PasswordFormPolicy.Node;

/**
 * Plain-JVM check of the engine-attested field-origin rule (BrowserFieldOrigin) and of the
 * structure BrowserLoginFields.Anchor reports, against plugin-native-passwords' PasswordFormPolicy.
 * The engine source stands for WebMessageListener's sourceOrigin and isMainFrame; the report is the
 * isolated-world reporter's message. Android views, WebView, AssistStructure, a provider, a vault
 * and a device are not run here.
 */
public final class BrowserFieldOriginTest {
 static final String HOST = "com.example.browser";
 static final String DOC = "0123456789abcdef01234567";
 static int checks = 0;

 static void eq(Object expected, Object actual, String what) {
  if (expected == null ? actual != null : !expected.equals(actual)) throw new AssertionError(what + ": expected " + expected + " got " + actual);
  checks++;
 }

 static BrowserFieldOrigin.TabSnapshot tab(String url, long navigation) {
  BrowserFieldOrigin.TabSnapshot t = new BrowserFieldOrigin.TabSnapshot();
  t.supported = true; t.navigation = navigation;
  t.state = new BrowserAutofillEligibility.TabState();
  t.state.selected = true; t.state.shown = true; t.state.committed = true;
  t.state.documentUrl = url; t.state.engineUrl = url;
  return t;
 }
 static BrowserFieldOrigin.EngineSource engine(String sourceOrigin, boolean mainFrame) {
  return new BrowserFieldOrigin.EngineSource(sourceOrigin, mainFrame);
 }
 static String origin(BrowserFieldOrigin.EngineSource e, BrowserFieldOrigin.TabSnapshot t) {
  BrowserFieldOrigin.Decision d = BrowserFieldOrigin.bind(e, t);
  if (d.fillable() == (d.refusal != null)) throw new AssertionError("decision is exactly one of origin or refusal");
  return d.origin;
 }
 static String refusal(BrowserFieldOrigin.EngineSource e, BrowserFieldOrigin.TabSnapshot t) {
  BrowserFieldOrigin.Decision d = BrowserFieldOrigin.bind(e, t);
  if (d.origin != null) throw new AssertionError("expected refusal, bound " + d.origin);
  return d.refusal;
 }
 static BrowserFieldOrigin.Report focus(String message) {
  BrowserFieldOrigin.Report r = BrowserFieldOrigin.Report.parse(message);
  if (r == null) throw new AssertionError("report should parse: " + message);
  return r;
 }

 /** Mirrors BrowserLoginFields.Anchor.onProvideAutofillVirtualStructure for a binding. */
 static Node anchor(String fieldOrigin, String topOrigin, boolean withUsername, String user, String pass) {
  java.net.URI uri = java.net.URI.create(fieldOrigin);
  Node root = new Node(); root.id = "anchor";
  root.webDomain = uri.getHost(); root.webScheme = uri.getScheme(); root.topOrigin = topOrigin;
  if (withUsername) root.add(child(fieldOrigin, false, 5, user));
  root.add(child(fieldOrigin, true, 6, pass));
  return root;
 }
 static Node child(String origin, boolean password, int id, String value) {
  java.net.URI uri = java.net.URI.create(origin);
  Node n = new Node(); n.id = id; n.text = true; n.visible = true; n.focused = password;
  n.hints = java.util.List.of(password ? "password" : "username");
  n.inputType = 1 | (password ? 0xe0 : 0xd0);
  n.htmlType = password ? "password" : "text";
  n.webDomain = uri.getHost(); n.webScheme = uri.getScheme(); n.fieldOrigin = origin;
  n.value = value;
  return n;
 }
 /** The activity: the tab WebView (excluded while attested fields exist, so empty) and the anchor. */
 static Node activity(Node anchor) { Node a = new Node(); Node web = new Node(); web.id = "web"; a.add(web).add(anchor); return a; }
 static String rejected(Node root, boolean forSave) {
  try { PasswordFormPolicy.evaluate(HOST, HOST, true, root, p -> false, forSave); return null; }
  catch (PasswordFormPolicy.Rejected r) { return r.getMessage(); }
 }

 public static void main(String[] args) throws Exception {
  String page = "https://example.com/login?next=/";
  // --- Admission: engine origin, committed HTTPS top level, same origin, current navigation, shown tab ---
  eq("https://example.com", origin(engine("https://example.com", true), tab(page, 4)), "top-level document");
  eq("https://example.com", origin(engine("https://example.com", false), tab(page, 4)), "same-origin iframe is the same site");
  eq("https://example.com:8443", origin(engine("https://example.com:8443", true), tab("https://example.com:8443/a", 4)), "port kept");
  eq("https://example.com", origin(engine("https://EXAMPLE.com:443", true), tab(page, 4)), "default port and case normalised");
  // Wrong origin and frames.
  eq(BrowserFieldOrigin.FRAME, refusal(engine("https://evil.example", false), tab(page, 4)), "cross-origin iframe denied");
  eq(BrowserFieldOrigin.FRAME, refusal(engine("https://accounts.example.com", false), tab(page, 4)), "same-site subdomain iframe denied");
  eq(BrowserFieldOrigin.FRAME, refusal(engine("https://example.com:8443", false), tab(page, 4)), "same host, other port iframe denied");
  eq(BrowserFieldOrigin.MISMATCH, refusal(engine("https://evil.example", true), tab(page, 4)), "main frame from another origin (stale commit) denied");
  eq(BrowserFieldOrigin.NO_ORIGIN, refusal(engine("null", false), tab(page, 4)), "sandboxed frame (opaque origin) denied");
  eq(BrowserFieldOrigin.NO_ORIGIN, refusal(engine(null, true), tab(page, 4)), "no engine origin");
  eq(BrowserFieldOrigin.NO_ORIGIN, refusal(engine("about:blank", false), tab(page, 4)), "non-network origin");
  eq(BrowserFieldOrigin.INSECURE, refusal(engine("http://example.com", false), tab(page, 4)), "cleartext frame denied");
  eq(BrowserFieldOrigin.HIDDEN, refusal(engine("http://example.com", true), tab("http://example.com/", 4)), "cleartext page is never eligible");
  eq(BrowserFieldOrigin.NO_ORIGIN, refusal(engine("https://user@example.com", true), tab(page, 4)), "user info is not an origin");
  // Stale navigation and hidden tabs.
  BrowserFieldOrigin.TabSnapshot hidden = tab(page, 4); hidden.state.shown = false;
  eq(BrowserFieldOrigin.HIDDEN, refusal(engine("https://example.com", true), hidden), "hidden tab");
  BrowserFieldOrigin.TabSnapshot background = tab(page, 4); background.state.selected = false;
  eq(BrowserFieldOrigin.HIDDEN, refusal(engine("https://example.com", true), background), "tab not selected");
  BrowserFieldOrigin.TabSnapshot paused = tab(page, 4); paused.state.paused = true;
  eq(BrowserFieldOrigin.HIDDEN, refusal(engine("https://example.com", true), paused), "Activity paused");
  BrowserFieldOrigin.TabSnapshot loading = tab(page, 4); loading.state.loading = true;
  eq(BrowserFieldOrigin.HIDDEN, refusal(engine("https://example.com", true), loading), "still loading");
  BrowserFieldOrigin.TabSnapshot overlay = tab(page, 4); overlay.state.overlay = true;
  eq(BrowserFieldOrigin.HIDDEN, refusal(engine("https://example.com", true), overlay), "site prompt open");
  BrowserFieldOrigin.TabSnapshot moved = tab(page, 4); moved.state.engineUrl = "https://evil.example/";
  eq(BrowserFieldOrigin.HIDDEN, refusal(engine("https://evil.example", true), moved), "engine URL disagrees with the committed URL");
  BrowserFieldOrigin.TabSnapshot failed = tab(page, 4); failed.state.loadError = "Page could not load.";
  eq(BrowserFieldOrigin.HIDDEN, refusal(engine("https://example.com", true), failed), "error page");
  // Unsupported WebView: fill stays off with a stated reason.
  BrowserFieldOrigin.TabSnapshot old = tab(page, 4); old.supported = false;
  eq(BrowserFieldOrigin.UNSUPPORTED, refusal(engine("https://example.com", true), old), "feature unsupported");
  eq(BrowserFieldOrigin.UNSUPPORTED, refusal(engine("https://example.com", true), null), "no snapshot");

  // --- Spoofing: the script message carries no origin; only the engine source decides ---
  String good = "focus|" + DOC + "|2|1|2|username|current-password|10,20,200,40,412";
  BrowserFieldOrigin.Report report = focus(good);
  eq(1, report.username, "username key"); eq(2, report.password, "password key"); eq(2, report.focused, "focused key");
  eq(null, BrowserFieldOrigin.Report.parse(good + "|https://example.com"), "an extra origin field is rejected, not ignored");
  eq(null, BrowserFieldOrigin.Report.parse("focus|" + DOC + "|2|1|2|username|current-password|10,20,200,40,412|origin=https://example.com"), "no origin key accepted");
  eq(null, BrowserFieldOrigin.Report.parse("origin|https://example.com"), "unknown kind");
  eq(null, BrowserFieldOrigin.Report.parse("{\"t\":\"focus\",\"origin\":\"https://example.com\"}"), "JSON with an origin is not a report");
  eq(null, BrowserFieldOrigin.Report.parse("focus|" + DOC + "|2|1|2|https://example.com|current-password|10,20,200,40,412"), "autocomplete slot cannot carry an origin");
  eq(null, BrowserFieldOrigin.Report.parse("focus|" + DOC + "|3|1|2|username|current-password|10,20,200,40,412"), "focused key must be a reported field");
  eq(null, BrowserFieldOrigin.Report.parse("focus|" + DOC + "|1|1|1|username||0,0,1,1,1"), "username and password are distinct");
  eq(null, BrowserFieldOrigin.Report.parse("focus|NOTHEX|2|1|2|username||0,0,1,1,1"), "document id must be the script's random hex");
  eq(null, BrowserFieldOrigin.Report.parse("focus|" + DOC + "|2|0|2|username||0,0,1,1,1"), "no username autocomplete without a username");
  eq(null, BrowserFieldOrigin.Report.parse("focus|" + DOC + "|2|1|2|username||1e9,0,1,1,1"), "numbers are bounded decimals");
  eq(null, BrowserFieldOrigin.Report.parse("x".repeat(5000)), "oversize message");
  eq(null, BrowserFieldOrigin.Report.parse(null), "no message");
  eq(BrowserFieldOrigin.Kind.BLUR, BrowserFieldOrigin.Report.parse("blur|" + DOC).kind, "blur");
  eq(BrowserFieldOrigin.Kind.GONE, BrowserFieldOrigin.Report.parse("gone|" + DOC).kind, "document unloading");
  eq(null, BrowserFieldOrigin.Report.parse("blur|" + DOC + "|https://example.com"), "blur has no other fields");
  BrowserFieldOrigin.Report submit = BrowserFieldOrigin.Report.parse("submit|" + DOC + "|1|2|ada%40example.com|p%C3%A4ss%20w%7Crd");
  eq("ada@example.com", submit.usernameValue, "submitted username decoded"); eq("päss w|rd", submit.passwordValue, "submitted password decoded");
  eq(null, BrowserFieldOrigin.Report.parse("submit|" + DOC + "|1|2|ada|"), "empty password is not a submission");
  eq(null, BrowserFieldOrigin.Report.parse("submit|" + DOC + "|1|2|ada|a+b"), "unencoded characters rejected");
  eq(null, BrowserFieldOrigin.Report.parse("submit|" + DOC + "|1|2|ada|%0A"), "control characters rejected");
  eq(null, BrowserFieldOrigin.Report.parse("submit|" + DOC + "|1|2|ada|%zz"), "malformed encoding rejected");
  // A page that claims the top-level origin from inside a cross-origin frame is still that frame:
  // bind() never sees the message, only what the engine reported for the posting frame.
  eq(BrowserFieldOrigin.FRAME, refusal(engine("https://ads.example", false), tab(page, 4)), "frame claiming the top origin in its message is still denied");

  // --- Binding lifetime: navigation, tab change, hidden tab, revoke ---
  BrowserFieldOrigin.Binding binding = new BrowserFieldOrigin.Binding(origin(engine("https://example.com", true), tab(page, 4)), 4, report);
  BrowserFieldOrigin.TabSnapshot now = tab(page, 4);
  eq(true, binding.admits(now), "bound on its tab and navigation");
  eq(true, binding.sameFrame(engine("https://example.com", true), focus("blur|" + DOC)), "same document");
  eq(false, binding.sameFrame(engine("https://example.com", true), focus("blur|fedcba9876543210")), "another document of the same origin");
  eq(false, binding.sameFrame(engine("https://evil.example", false), focus("blur|" + DOC)), "another origin reusing the document id");
  eq(true, binding.sameFields(engine("https://example.com", true), focus("focus|" + DOC + "|1|1|2|username||0,0,1,1,1")), "re-focus of the same fields keeps the binding");
  eq(false, binding.sameFields(engine("https://example.com", true), focus("focus|" + DOC + "|3|3|4|username||0,0,1,1,1")), "other fields of the same document are a new binding");
  eq(false, binding.sameFields(engine("https://example.com", true), focus("blur|" + DOC)), "only a focus report re-focuses");
  now.navigation = 5;
  eq(false, binding.admits(now), "a new navigation invalidates the binding (stale fill dropped)");
  now = tab(page, 4); now.state.selected = false;
  eq(false, binding.admits(now), "another tab selected");
  now = tab(page, 4); now.state.shown = false;
  eq(false, binding.admits(now), "tab hidden");
  now = tab(page, 4); now.state.paused = true;
  eq(false, binding.admits(now), "paused for provider unlock: values wait for resume");
  now = tab("https://example.com:8443/", 4);
  eq(false, binding.admits(now), "top-level origin changed in place");
  now = tab(page, 4); now.supported = false;
  eq(false, binding.admits(now), "unsupported");
  now = tab(page, 4);
  binding.revoke();
  eq(false, binding.admits(now), "revoked (focus elsewhere, cancel, overlay, close): late values dropped");
  eq(false, binding.sameFrame(engine("https://example.com", true), focus("blur|" + DOC)), "revoked binding owns no frame");
  eq(false, binding.admits(null), "no tab");

  // --- Deferred focus: a field focused before the tab is eligible (autofocus during load) ---
  BrowserFieldOrigin.EngineSource top = engine("https://example.com", true);
  BrowserFieldOrigin.TabSnapshot early = tab(page, 7); early.state.loading = true;
  BrowserFieldOrigin.Deferred deferred = BrowserFieldOrigin.Deferred.of(top, report, early, BrowserFieldOrigin.bind(top, early));
  eq(true, deferred != null, "focus while the page loads is kept for retry");
  BrowserFieldOrigin.TabSnapshot finished = tab(page, 7);
  eq(true, deferred.current(finished), "same navigation once the load finishes");
  eq("https://example.com", origin(deferred.engine, finished), "retry binds through the full rule once eligible");
  BrowserFieldOrigin.TabSnapshot prompt = tab(page, 7); prompt.state.overlay = true;
  eq(true, BrowserFieldOrigin.Deferred.of(top, report, prompt, BrowserFieldOrigin.bind(top, prompt)) != null, "focus while a site prompt is open is kept");
  eq(false, deferred.current(tab(page, 8)), "a later navigation never inherits the deferred field");
  eq(true, deferred.sameFrame(top, focus("blur|" + DOC)), "blur of the same document ends the wait");
  eq(false, deferred.sameFrame(engine("https://evil.example", false), focus("blur|" + DOC)), "another frame cannot end the wait");
  eq(false, deferred.sameFrame(top, focus("blur|fedcba9876543210")), "another document cannot end the wait");
  BrowserFieldOrigin.EngineSource frame = engine("https://evil.example", false);
  BrowserFieldOrigin.Deferred framed = BrowserFieldOrigin.Deferred.of(frame, report, early, BrowserFieldOrigin.bind(frame, early));
  eq(true, framed != null, "a cross-origin frame focused during load is only kept, never bound");
  eq(BrowserFieldOrigin.FRAME, refusal(framed.engine, finished), "and is still refused once the tab is eligible");
  eq(null, BrowserFieldOrigin.Deferred.of(frame, report, finished, BrowserFieldOrigin.bind(frame, finished)), "a final refusal is not retried");
  BrowserFieldOrigin.TabSnapshot unsupported = tab(page, 7); unsupported.supported = false;
  eq(null, BrowserFieldOrigin.Deferred.of(top, report, unsupported, BrowserFieldOrigin.bind(top, unsupported)), "unsupported WebView is not retried");
  eq(null, BrowserFieldOrigin.Deferred.of(top, focus("blur|" + DOC), early, BrowserFieldOrigin.bind(top, early)), "only focus reports are kept");
  eq(null, BrowserFieldOrigin.Deferred.of(top, report, finished, BrowserFieldOrigin.bind(top, finished)), "an admitted focus needs no retry");

  // --- The pinned upstream policy with the anchor's structure ---
  String bound = "https://example.com:8443";
  PasswordFormPolicy.Target fill = PasswordFormPolicy.evaluate(HOST, HOST, true, activity(anchor(bound, bound, true, null, null)), p -> false, false);
  eq(bound, fill.webOrigin, "fill binds to the exact engine origin, port included");
  eq(null, fill.appPackage, "never the host app identity");
  eq(5, fill.usernameId, "username virtual field"); eq(6, fill.passwordId, "password virtual field");
  eq(bound, PasswordFormPolicy.evaluate(HOST, HOST, true, activity(anchor(bound, bound, false, null, null)), p -> false, false).webOrigin, "password-only form");
  PasswordFormPolicy.Target save = PasswordFormPolicy.evaluate(HOST, HOST, true, activity(anchor(bound, bound, true, "ada", "s3cret")), p -> false, true);
  eq(bound, save.webOrigin, "save binds to the same origin"); eq("ada", save.username, "save username"); eq("s3cret", save.password, "save password");
  // What the policy would refuse if the adapter ever mis-reported.
  Node noField = anchor(bound, bound, true, null, null); noField.children.get(1).fieldOrigin = null;
  eq("Field origin unavailable", rejected(activity(noField), false), "missing field origin (standard WebView)");
  eq("Cross-origin frame", rejected(activity(anchor("https://evil.example", bound, true, null, null)), false), "field origin of another host than the top level");
  Node otherPort = anchor(bound, bound, true, null, null); for (Node c : otherPort.children) c.fieldOrigin = "https://example.com";
  eq("Cross-origin frame", rejected(activity(otherPort), false), "field origin on another port");
  Node noTop = anchor(bound, null, true, null, null);
  eq("Top-level origin unavailable", rejected(activity(noTop), false), "no committed top-level origin");
  // While attested fields exist the tab WebView reports no children; were it re-enabled, its
  // fields would make the request ambiguous rather than fillable.
  Node both = activity(anchor(bound, bound, true, null, null)); Node web = both.children.get(0);
  web.webDomain = "example.com"; web.webScheme = "https";
  Node wp = new Node(); wp.id = "wp"; wp.text = true; wp.htmlType = "password"; web.add(wp);
  eq("Ambiguous password fields", rejected(both, false), "the WebView's own structure must stay excluded");

  System.out.println(checks + " assertions passed");
 }
}
