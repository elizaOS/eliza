package ai.eliza.plugins.passwords;

import ai.eliza.plugins.securestore.nativeonly.PasswordFacets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Set;

/**
 * Pure fill/save admission for Android Autofill structures. Android types are converted to
 * {@link Node} by {@code AutofillStructures}; everything security-relevant is decided here so it
 * can be tested on a JVM.
 *
 * <p>Rules:
 * <ul>
 *   <li>The requesting package comes from the framework ({@code AssistStructure#getActivityComponent}),
 *   never from a caller-supplied value.</li>
 *   <li>Web content is accepted only from a trusted browser. Every web node and every login field
 *   must report the same HTTPS domain and an explicit native field origin; any second domain is treated as a cross-origin frame and
 *   the request is refused. Mixed native and web login fields are refused.</li>
 *   <li>When the host itself is the browser, its own WebView must also report the committed
 *   top-level origin ({@link #TOP_ORIGIN_EXTRA}); its host must equal the field domain, and the
 *   target is that exact origin, port included. Android's field metadata carries no port, so
 *   for other browsers the target is the default-port origin of the reported domain.</li>
 *   <li>A password field needs an explicit signal (autofill hint, HTML type or password input
 *   type). Page text, labels and ids are never used to classify the password field.</li>
 *   <li>The host's own native UI is never filled.</li>
 * </ul>
 */
public final class PasswordFormPolicy {
  private PasswordFormPolicy() {}
  /** Extra a host browser WebView puts on its own autofill node: the committed top-level origin. */
  public static final String TOP_ORIGIN_EXTRA = "ai.eliza.passwords.topOrigin";
  static final int MAX_DEPTH = 40, MAX_NODES = 1500;
  // android.text.InputType constants, inlined to keep this class Android-free.
  static final int CLASS_MASK = 0x0f, VARIATION_MASK = 0xff0, CLASS_TEXT = 1, CLASS_NUMBER = 2;
  static final int TEXT_PASSWORD = 0x80, TEXT_VISIBLE_PASSWORD = 0x90, TEXT_WEB_PASSWORD = 0xe0, NUMBER_PASSWORD = 0x10;
  static final int TEXT_EMAIL = 0x20, TEXT_WEB_EMAIL = 0xd0;

  public static final class Rejected extends Exception {
    public Rejected(String reason) { super(reason, null, false, false); }
  }

  /** Framework view node reduced to the fields this policy reads. {@code id} is opaque. */
  public static final class Node {
    public Object id;
    public String webDomain, webScheme, htmlType, htmlAutocomplete, topOrigin, fieldOrigin;
    public List<String> hints = Collections.emptyList();
    public int inputType;
    public boolean text, visible = true, focused;
    /** Only populated for save requests. */
    public String value;
    public final List<Node> children = new ArrayList<>();
    public Node add(Node child) { children.add(child); return this; }
  }

  public interface BrowserTrust { boolean trusted(String packageName); }

  /** Admitted login target. Exactly one of {@code webOrigin} or {@code appPackage} is set. */
  public static final class Target {
    public final String webOrigin, appPackage;
    public final Object usernameId, passwordId;
    public final String username, password;
    Target(String webOrigin, String appPackage, Object usernameId, Object passwordId, String username, String password) {
      this.webOrigin = webOrigin; this.appPackage = appPackage; this.usernameId = usernameId; this.passwordId = passwordId;
      this.username = username; this.password = password;
    }
    public boolean web() { return webOrigin != null; }
    /** Display identity: the origin or the package name. Not a secret. */
    public String subject() { return web() ? webOrigin : appPackage; }
    /** Copy without captured values, for holding a fill offer. */
    public Target withoutValues() { return new Target(webOrigin, appPackage, usernameId, passwordId, null, null); }
  }

  private static final class Field {
    final Node node; final String domain, scheme;
    Field(Node node, String domain, String scheme) { this.node = node; this.domain = domain; this.scheme = scheme; }
  }

  public static Target evaluate(String packageName, String hostPackage, boolean hostIsBrowser, Node root, BrowserTrust trust, boolean forSave) throws Rejected {
    if (packageName == null || packageName.isEmpty() || root == null || trust == null) throw new Rejected("Missing request identity");
    List<Field> fields = new ArrayList<>();
    Set<String> domains = new LinkedHashSet<>(), schemes = new LinkedHashSet<>(), topOrigins = new LinkedHashSet<>();
    int[] count = {0};
    walk(root, null, null, 0, count, fields, domains, schemes, topOrigins);

    List<Field> passwords = new ArrayList<>(), others = new ArrayList<>();
    for (Field field : fields) {
      if (!field.node.text || field.node.id == null) continue;
      if (!forSave && !field.node.visible) continue;
      if (isPassword(field.node)) passwords.add(field); else others.add(field);
    }
    if (passwords.isEmpty()) throw new Rejected("No password field");
    if (!forSave && passwords.size() != 1) throw new Rejected("Ambiguous password fields");
    if (forSave && passwords.size() > 2) throw new Rejected("Ambiguous password fields");
    Field password = passwords.get(0);
    Field username = username(others, password, fields);

    String webOrigin = null;
    if (!domains.isEmpty()) {
      boolean hostRequest = packageName.equals(hostPackage);
      if (hostRequest ? !hostIsBrowser : !trust.trusted(packageName)) throw new Rejected("Untrusted browser");
      if (domains.size() != 1) throw new Rejected("Cross-origin frame");
      if (schemes.size() != 1 || !schemes.contains("https")) throw new Rejected("Insecure origin");
      List<Field> login = new ArrayList<>(passwords); if (username != null) login.add(username);
      for (Field field : login) if (field.domain == null) throw new Rejected("Mixed native and web fields");
      try { webOrigin = PasswordFacets.webDomain("https", domains.iterator().next()); }
      catch (Exception invalid) { throw new Rejected("Unsupported web origin"); }
      if (hostRequest) {
        if (topOrigins.size() != 1) throw new Rejected("Top-level origin unavailable");
        String top;
        try { top = PasswordFacets.web(topOrigins.iterator().next()); } catch (Exception invalid) { throw new Rejected("Top-level origin unavailable"); }
        // Android reports a field's web domain without its port; the host's committed top-level
        // origin carries it. Same host: the exact origin is the top-level one (port included).
        if (!host(top).equals(host(webOrigin))) throw new Rejected("Cross-origin frame");
        webOrigin = top;
      }
      // A form-level domain is not a field origin. Chromium can flatten iframe
      // inputs into the top-level form, and Android drops the URL's port.
      // Require the existing native per-field origin contract; never infer it
      // from the form or the host's top-level extra.
      for (Field field : login) {
        String exact;
        try { exact = PasswordFacets.web(field.node.fieldOrigin); }
        catch (Exception unavailable) { throw new Rejected("Field origin unavailable"); }
        if (!webOrigin.equals(exact)) throw new Rejected("Cross-origin frame");
      }
    } else {
      if (!topOrigins.isEmpty()) throw new Rejected("Top-level origin without web fields");
      if (packageName.equals(hostPackage)) throw new Rejected("Host interface is never filled");
    }

    String capturedPassword = null, capturedUsername = null;
    if (forSave) {
      for (Field field : passwords) {
        String value = field.node.value;
        if (value == null || value.isEmpty()) continue;
        if (capturedPassword != null && !capturedPassword.equals(value)) throw new Rejected("Different passwords entered");
        capturedPassword = value;
      }
      if (capturedPassword == null) throw new Rejected("No password entered");
      capturedUsername = username == null || username.node.value == null ? "" : username.node.value;
    }
    return new Target(webOrigin, webOrigin == null ? packageName : null, username == null ? null : username.node.id, password.node.id, capturedUsername, capturedPassword);
  }

  private static String host(String origin) {
    int start = "https://".length(), port = origin.indexOf(':', start);
    return port < 0 ? origin.substring(start) : origin.substring(start, port);
  }

  private static void walk(Node node, String domain, String scheme, int depth, int[] count, List<Field> fields,
      Set<String> domains, Set<String> schemes, Set<String> topOrigins) throws Rejected {
    if (depth > MAX_DEPTH || ++count[0] > MAX_NODES) throw new Rejected("Form exceeds bounds");
    if (node.webDomain != null && !node.webDomain.isEmpty()) {
      domain = node.webDomain.toLowerCase(Locale.ROOT);
      scheme = node.webScheme == null ? "" : node.webScheme.toLowerCase(Locale.ROOT);
      domains.add(domain); schemes.add(scheme);
    }
    if (node.topOrigin != null) topOrigins.add(node.topOrigin);
    fields.add(new Field(node, domain, scheme));
    for (Node child : node.children) walk(child, domain, scheme, depth + 1, count, fields, domains, schemes, topOrigins);
  }

  static boolean isPassword(Node node) {
    for (String hint : node.hints) {
      String value = hint == null ? "" : hint.toLowerCase(Locale.ROOT);
      if (value.equals("password") || value.equals("current-password") || value.equals("new-password")) return true;
    }
    if ("password".equalsIgnoreCase(node.htmlType)) return true;
    int type = node.inputType, variation = type & VARIATION_MASK;
    if ((type & CLASS_MASK) == CLASS_TEXT && (variation == TEXT_PASSWORD || variation == TEXT_VISIBLE_PASSWORD || variation == TEXT_WEB_PASSWORD)) return true;
    return (type & CLASS_MASK) == CLASS_NUMBER && variation == NUMBER_PASSWORD;
  }

  static boolean isUsername(Node node) {
    for (String hint : node.hints) {
      String value = hint == null ? "" : hint.toLowerCase(Locale.ROOT);
      if (value.equals("username") || value.equals("emailaddress") || value.equals("email")) return true;
    }
    String auto = node.htmlAutocomplete == null ? "" : node.htmlAutocomplete.toLowerCase(Locale.ROOT);
    for (String token : auto.split("\\s+")) if (token.equals("username") || token.equals("email")) return true;
    if ("email".equalsIgnoreCase(node.htmlType)) return true;
    int type = node.inputType, variation = type & VARIATION_MASK;
    return (type & CLASS_MASK) == CLASS_TEXT && (variation == TEXT_EMAIL || variation == TEXT_WEB_EMAIL);
  }

  /** Explicit username hint first; otherwise the nearest text field before the password. */
  private static Field username(List<Field> others, Field password, List<Field> traversal) {
    for (Field field : others) if (Objects.equals(field.domain, password.domain) && isUsername(field.node)) return field;
    Field previous = null;
    for (Field field : traversal) {
      if (field == password) return previous;
      if (others.contains(field) && Objects.equals(field.domain, password.domain)) previous = field;
    }
    return null;
  }
}
