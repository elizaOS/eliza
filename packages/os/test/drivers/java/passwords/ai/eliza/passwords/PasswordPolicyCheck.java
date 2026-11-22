package ai.eliza.passwords;

import ai.eliza.plugins.passwords.PasswordEditorPolicy;
import ai.eliza.plugins.passwords.PasswordFormPolicy;
import ai.eliza.plugins.passwords.PasswordFormPolicy.Node;
import ai.eliza.plugins.passwords.PasswordFormPolicy.Target;
import ai.eliza.plugins.passwords.PasswordGenerator;
import ai.eliza.plugins.passwords.PasswordMatching;
import ai.eliza.plugins.passwords.PasswordRequests;
import ai.eliza.plugins.securestore.nativeonly.PasswordBackupApproval;
import ai.eliza.plugins.securestore.nativeonly.PasswordBackupApproval.Grant;
import ai.eliza.plugins.securestore.nativeonly.PasswordBackupApproval.Owner;
import ai.eliza.plugins.securestore.nativeonly.PasswordBackupApproval.Purpose;
import ai.eliza.plugins.securestore.nativeonly.PasswordFacets;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.URL;
import java.net.URLConnection;
import java.net.URLStreamHandler;
import java.security.cert.Certificate;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.net.ssl.HttpsURLConnection;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public final class PasswordPolicyCheck {
  private interface Failing { void run() throws Exception; }

  private static final String HOST = "ai.example.host", BROWSER = "org.example.browser", APP = "com.example.bank";
  private static final PasswordFormPolicy.BrowserTrust TRUST = BROWSER::equals;
  private static final int TEXT = 1, TEXT_PASSWORD = 0x81, TEXT_EMAIL = 0x21;
  private static final SecureRandom RANDOM = new SecureRandom();

  private final List<String> failed = new ArrayList<>();
  private int checks;

  private void check(String name, boolean value) {
    checks++;
    if (!value) failed.add(name);
  }

  private void rejects(String name, String reason, Failing body) {
    checks++;
    try {
      body.run();
      failed.add(name + ": accepted");
    } catch (PasswordFormPolicy.Rejected rejected) {
      if (reason != null && !reason.equals(rejected.getMessage())) failed.add(name + ": " + rejected.getMessage());
    } catch (Exception other) {
      if (reason != null) failed.add(name + ": " + other);
    }
  }

  private static Node field(String id, int inputType, String... hints) {
    Node node = new Node();
    node.id = id;
    node.text = true;
    node.inputType = inputType;
    node.hints = Arrays.asList(hints);
    return node;
  }

  private static Node valued(String id, int inputType, String value) {
    Node node = field(id, inputType);
    node.value = value;
    return node;
  }

  private static Node web(String domain, String scheme, Node... children) {
    Node node = new Node();
    node.webDomain = domain;
    node.webScheme = scheme;
    for (Node child : children) {
      if (child.text) child.fieldOrigin = scheme + "://" + domain;
      node.add(child);
    }
    return node;
  }

  private static Node topped(String top, Node view) {
    view.topOrigin = top;
    return view;
  }

  private static Node root(Node... children) {
    Node node = new Node();
    for (Node child : children) node.add(child);
    return node;
  }

  private static Node login(String domain) {
    return web(domain, "https", field("u", TEXT), field("p", TEXT_PASSWORD));
  }

  private static Target fill(String pkg, boolean hostBrowser, Node root) throws Exception {
    return PasswordFormPolicy.evaluate(pkg, HOST, hostBrowser, root, TRUST, false);
  }

  private static Target save(String pkg, Node root) throws Exception {
    return PasswordFormPolicy.evaluate(pkg, HOST, false, root, TRUST, true);
  }

  private static Target site() throws Exception {
    return fill(BROWSER, false, web("Accounts.Example.com", "https", field("u", TEXT), field("p", TEXT_PASSWORD)));
  }

  private static Target captured() throws Exception {
    return save(BROWSER, web("example.com", "https", valued("u", TEXT_EMAIL, "synthetic.user@example.test"), valued("p", TEXT_PASSWORD, "synthetic-value-1"), valued("c", TEXT_PASSWORD, "synthetic-value-1")));
  }

  private void generator() {
    String alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!#$%&*+-=?@^_~";
    Set<Character> seen = new HashSet<>();
    boolean lengths = true, classes = true, declared = true;
    for (int run = 0; run < 400; run++) {
      String value = PasswordGenerator.generate(PasswordGenerator.Options.defaults(), RANDOM);
      lengths &= value.length() == 20;
      classes &= value.chars().anyMatch(Character::isLowerCase) && value.chars().anyMatch(Character::isUpperCase)
        && value.chars().anyMatch(Character::isDigit) && value.chars().anyMatch(c -> "!#$%&*+-=?@^_~".indexOf(c) >= 0);
      for (char c : value.toCharArray()) {
        declared &= alphabet.indexOf(c) >= 0;
        seen.add(c);
      }
    }
    check("default length is 20", lengths);
    check("every character class is present", classes);
    check("only the declared alphabet", declared);
    check("the whole alphabet is reachable", seen.size() == alphabet.length());
    check("digits only", PasswordGenerator.generate(new PasswordGenerator.Options(8, false, false, true, false), RANDOM).matches("[2-9]{8}"));
    rejects("shorter than 8", null, () -> PasswordGenerator.generate(new PasswordGenerator.Options(7, true, true, true, true), RANDOM));
    rejects("longer than 128", null, () -> PasswordGenerator.generate(new PasswordGenerator.Options(129, true, true, true, true), RANDOM));
    rejects("no character class", null, () -> PasswordGenerator.generate(new PasswordGenerator.Options(20, false, false, false, false), RANDOM));
  }

  private void fills() throws Exception {
    Target app = fill(APP, true, root(field("user", TEXT_EMAIL), field("pass", TEXT_PASSWORD)));
    check("an app sign-in binds the framework-reported package", !app.web() && APP.equals(app.appPackage) && "user".equals(app.usernameId) && "pass".equals(app.passwordId) && app.password == null);
    rejects("the host interface", "Host interface is never filled", () -> fill(HOST, true, root(field("user", TEXT), field("pass", TEXT_PASSWORD))));
    Node misleading = field("password", TEXT, "Enter password");
    rejects("a label is no password signal", "No password field", () -> fill(APP, false, root(field("user", TEXT), misleading)));
    Node htmlPassword = field("p", TEXT);
    htmlPassword.htmlType = "password";
    check("an HTML password type", "p".equals(fill(APP, false, root(field("u", TEXT), htmlPassword)).passwordId));
    check("a current-password hint", "p".equals(fill(APP, false, root(field("u", TEXT), field("p", TEXT, "current-password"))).passwordId));
    rejects("two password fields", "Ambiguous password fields", () -> fill(APP, false, root(field("u", TEXT), field("p1", TEXT_PASSWORD), field("p2", TEXT_PASSWORD))));
    Node hidden = field("hidden", TEXT_PASSWORD);
    hidden.visible = false;
    check("a hidden password field is skipped", "p".equals(fill(APP, false, root(field("u", TEXT), hidden, field("p", TEXT_PASSWORD))).passwordId));
    check("an explicit username hint wins", "email".equals(fill(APP, false, root(field("email", TEXT, "emailAddress"), field("search", TEXT), field("p", TEXT_PASSWORD))).usernameId));
    check("otherwise the nearest preceding field", "second".equals(fill(APP, false, root(field("first", TEXT), field("second", TEXT), field("p", TEXT_PASSWORD), field("after", TEXT))).usernameId));
    check("no username before the password", fill(APP, false, root(field("p", TEXT_PASSWORD))).usernameId == null);

    Target site = site();
    check("a trusted browser fills one exact lower-case HTTPS origin", site.web() && site.webOrigin.equals("https://accounts.example.com") && site.appPackage == null);
    rejects("an untrusted browser", "Untrusted browser", () -> fill(APP, false, login("example.com")));
    rejects("plain HTTP", "Insecure origin", () -> fill(BROWSER, false, web("example.com", "http", field("u", TEXT), field("p", TEXT_PASSWORD))));
    rejects("no scheme", "Insecure origin", () -> fill(BROWSER, false, web("example.com", null, field("u", TEXT), field("p", TEXT_PASSWORD))));
    rejects("a password in a cross-origin frame", "Cross-origin frame", () -> fill(BROWSER, false, web("example.com", "https", field("u", TEXT), web("evil.example", "https", field("p", TEXT_PASSWORD)))));
    rejects("any second domain in the structure", "Cross-origin frame", () -> fill(BROWSER, false, web("example.com", "https", field("u", TEXT), field("p", TEXT_PASSWORD), web("ads.example", "https", field("x", TEXT)))));
    check("an address bar is never the web username", fill(BROWSER, false, root(field("address-bar", TEXT), web("example.com", "https", field("p", TEXT_PASSWORD)))).usernameId == null);
    rejects("native and web fields mixed", "Mixed native and web fields", () -> fill(BROWSER, false, root(field("native-pass", TEXT_PASSWORD), web("example.com", "https", field("u", TEXT)))));

    Node hostView = topped("https://example.com", login("example.com"));
    check("the host browser fills its committed top-level origin", fill(HOST, true, root(hostView)).webOrigin.equals("https://example.com"));
    rejects("the host is no browser", "Untrusted browser", () -> fill(HOST, false, root(hostView)));
    rejects("a frame under another top-level origin", "Cross-origin frame", () -> fill(HOST, true, root(topped("https://news.example", login("login.example")))));
    Node ported = topped("https://example.com:8443", login("example.com"));
    for (Node child : ported.children) child.fieldOrigin = "https://example.com:8443";
    Target portedTarget = fill(HOST, true, root(ported));
    check("the top-level origin supplies the exact port", portedTarget.webOrigin.equals("https://example.com:8443"));
    check("a portless entry does not match a ported origin", !PasswordMatching.matches(List.of("https://example.com"), portedTarget, null));
    check("the ported entry matches", PasswordMatching.matches(List.of("https://example.com:8443"), portedTarget, null));
    check("the default port is dropped", fill(HOST, true, root(topped("https://example.com:443", login("example.com")))).webOrigin.equals("https://example.com"));
    rejects("a subdomain under its parent's top-level origin", "Cross-origin frame", () -> fill(HOST, true, root(topped("https://example.com", login("accounts.example.com")))));
    rejects("an HTTP top-level origin", "Top-level origin unavailable", () -> fill(HOST, true, root(topped("http://example.com", login("example.com")))));
    rejects("no top-level origin", "Top-level origin unavailable", () -> fill(HOST, true, root(login("example.com"))));
    rejects("a top-level origin without web fields", "Top-level origin without web fields", () -> fill(APP, false, topped("https://example.com", root(field("u", TEXT), field("p", TEXT_PASSWORD)))));
    Node flattened = topped("https://example.com", login("example.com"));
    flattened.children.get(1).fieldOrigin = null;
    rejects("a field without its own origin", "Field origin unavailable", () -> fill(HOST, true, root(flattened)));
    flattened.children.get(1).fieldOrigin = "https://example.org";
    rejects("a flattened field of another origin", "Cross-origin frame", () -> fill(HOST, true, root(flattened)));
    flattened.children.get(1).fieldOrigin = "https://example.com:8443";
    rejects("a flattened field of another port", "Cross-origin frame", () -> fill(HOST, true, root(flattened)));
    Node deep = root();
    Node cursor = deep;
    for (int depth = 0; depth < 60; depth++) {
      Node next = root();
      cursor.add(next);
      cursor = next;
    }
    cursor.add(field("p", TEXT_PASSWORD));
    rejects("a structure past the bounds", "Form exceeds bounds", () -> fill(APP, false, deep));
  }

  private void saves() throws Exception {
    Target captured = captured();
    check("a save reads agreeing values", "synthetic.user@example.test".equals(captured.username) && "synthetic-value-1".equals(captured.password));
    Target stripped = captured.withoutValues();
    check("a stripped capture keeps only its origin", stripped.password == null && stripped.username == null && stripped.webOrigin.equals(captured.webOrigin));
    Node user = valued("u", TEXT_EMAIL, "synthetic.user@example.test");
    rejects("confirm fields that differ", "Different passwords entered", () -> save(BROWSER, web("example.com", "https", user, valued("p", TEXT_PASSWORD, "synthetic-value-1"), valued("c", TEXT_PASSWORD, "synthetic-value-2"))));
    rejects("an empty password", "No password entered", () -> save(APP, root(valued("u", TEXT_EMAIL, "synthetic.user@example.test"), valued("p", TEXT_PASSWORD, ""))));
    long[] now = {1000};
    PasswordRequests requests = new PasswordRequests(() -> now[0], RANDOM);
    String token = requests.offerSave(captured, captured.webOrigin);
    check("an unknown save token opens nothing", requests.takeSave("not-a-token") == null);
    PasswordRequests.SaveCapture saved = requests.takeSave(token);
    check("a save token yields its values and proved facet once", saved != null && "synthetic-value-1".equals(saved.target.password) && captured.webOrigin.equals(saved.facet) && requests.takeSave(token) == null);
  }

  private void matching() throws Exception {
    Target site = site();
    Target app = fill(APP, true, root(field("user", TEXT_EMAIL), field("pass", TEXT_PASSWORD)));
    String cert = "ab".repeat(32), otherCert = "cd".repeat(32);
    List<String> bindings = List.of("https://accounts.example.com", PasswordFacets.android(APP, cert));
    PasswordMatching.SignerCheck signers = (pkg, digest) -> APP.equals(pkg) && cert.equals(digest);
    check("the exact origin matches", PasswordMatching.matches(bindings, site, signers));
    check("a parent origin does not match", !PasswordMatching.matches(List.of("https://example.com"), site, signers));
    check("an app binding with its current signer matches", PasswordMatching.matches(bindings, app, signers));
    check("an app whose signer is not confirmed does not match", !PasswordMatching.matches(bindings, app, (pkg, digest) -> false));
    check("another signer does not match", !PasswordMatching.matches(List.of(PasswordFacets.android(APP, otherCert)), app, signers));
    check("another package does not match", !PasswordMatching.matches(List.of(PasswordFacets.android("com.example.other", cert)), app, signers));
    check("a web binding never matches an app", !PasswordMatching.matches(List.of("https://accounts.example.com"), app, signers));
  }

  private void offers() throws Exception {
    Target site = site();
    long[] now = {1000};
    PasswordRequests requests = new PasswordRequests(() -> now[0], RANDOM);
    String first = requests.offerFill(captured());
    check("a token is 48 hex digits", first.matches("[a-f0-9]{48}"));
    String second = requests.offerFill(site);
    check("a newer offer replaces the older", requests.takeFill(first) == null);
    Target offered = requests.takeFill(second);
    check("a fill offer carries no value and opens once", offered != null && offered.password == null && requests.takeFill(second) == null);
    String expiring = requests.offerFill(site);
    now[0] += PasswordRequests.FILL_TTL_MILLIS;
    check("an offer expires after its window", requests.takeFill(expiring) == null);
    String cancelled = requests.offerFill(site);
    requests.cancelFill(cancelled);
    check("a cancelled offer opens nothing", requests.takeFill(cancelled) == null);
    String opened = requests.offerFill(site);
    check("an opened offer stays current", requests.takeFill(opened) != null && requests.currentFill(opened));
    requests.cancelFill(opened);
    check("cancelling an opened picker ends it", !requests.currentFill(opened) && !requests.claimFill(opened));
    String older = requests.offerFill(site);
    check("the older picker opens", requests.takeFill(older) != null);
    String newer = requests.offerFill(site);
    check("a newer offer retires the older picker", !requests.currentFill(older) && !requests.claimFill(older));
    requests.cancelFill(older);
    check("cancelling a retired picker leaves the current offer", requests.takeFill(newer) != null && requests.claimFill(newer));
    check("a picker publishes once", !requests.claimFill(newer));
    String aging = requests.offerFill(site);
    now[0] += PasswordRequests.FILL_TTL_MILLIS - 1;
    check("an offer opens within its window", requests.takeFill(aging) != null);
    now[0]++;
    check("an open picker ends with its window", !requests.currentFill(aging) && !requests.claimFill(aging));
  }

  private void editor() throws Exception {
    check("nothing creates an entry", !PasswordEditorPolicy.admit(List.<String>of().iterator(), null, null).editing());
    PasswordEditorPolicy.Request edit = PasswordEditorPolicy.admit(List.of("entryId", "expectedRevision").iterator(), "id-1", 3);
    check("an edit names an entry and its revision", edit.editing() && edit.entryId.equals("id-1") && edit.expectedRevision == 3);
    check("revision zero is a revision", PasswordEditorPolicy.admit(List.of("entryId", "expectedRevision").iterator(), "id-1", 0L).expectedRevision == 0);
    rejects("a draft password", null, () -> PasswordEditorPolicy.admit(List.of("password").iterator(), null, null));
    rejects("an edit with a draft password", null, () -> PasswordEditorPolicy.admit(List.of("entryId", "expectedRevision", "password").iterator(), "id-1", 3));
    rejects("an entry without a revision", null, () -> PasswordEditorPolicy.admit(List.of("entryId").iterator(), "id-1", null));
    rejects("a revision without an entry", null, () -> PasswordEditorPolicy.admit(List.of("expectedRevision").iterator(), null, 3));
    rejects("an empty entry id", null, () -> PasswordEditorPolicy.admit(List.of("entryId", "expectedRevision").iterator(), "", 3));
    rejects("a negative revision", null, () -> PasswordEditorPolicy.admit(List.of("entryId", "expectedRevision").iterator(), "id-1", -1));
    rejects("a text revision", null, () -> PasswordEditorPolicy.admit(List.of("entryId", "expectedRevision").iterator(), "id-1", "3"));
    rejects("a fractional revision", null, () -> PasswordEditorPolicy.admit(List.of("entryId", "expectedRevision").iterator(), "id-1", 1.5));
    check("metadata of an existing entry", PasswordEditorPolicy.metadataOnly(List.of("id", "label", "username", "websites", "keepBindings").iterator(), "id-1"));
    check("a password is not metadata", !PasswordEditorPolicy.metadataOnly(List.of("id", "password").iterator(), "id-1"));
    check("generation is not metadata", !PasswordEditorPolicy.metadataOnly(List.of("id", "generate").iterator(), "id-1"));
    check("a new entry is not metadata", !PasswordEditorPolicy.metadataOnly(List.of("label").iterator(), null));
    String appBinding = PasswordFacets.android(APP, "ab".repeat(32));
    List<String> stored = List.of(appBinding, "https://a.example", "https://b.example");
    check("the editor shows the first web binding", PasswordEditorPolicy.firstWeb(stored).equals("https://a.example") && PasswordEditorPolicy.firstWeb(List.of(appBinding)).isEmpty());
    check("an edit replaces the first web binding", PasswordEditorPolicy.editedBindings(stored, "https://c.example").equals(List.of(appBinding, "https://c.example", "https://b.example")));
    check("clearing drops the first web binding", PasswordEditorPolicy.editedBindings(stored, null).equals(List.of(appBinding, "https://b.example")));
    check("an app-only entry gains a web binding", PasswordEditorPolicy.editedBindings(List.of(appBinding), "https://c.example").equals(List.of(appBinding, "https://c.example")));
    check("an app binding is never dropped", PasswordEditorPolicy.editedBindings(List.of(appBinding), null).equals(List.of(appBinding)));
  }

  private static final URI BACKUP = URI.create("https://cloud.example.test/api/v1/app-auth/mobile/password-backup");
  private static final Owner OWNER = new Owner("account-1", "organization-1");
  private static final String PROOF = "pbackup_" + "t".repeat(43), STATE = "state-1", VERIFIER = "verifier-1";
  private static final byte[] SNAPSHOT = { 7, 8, 9 };
  private static final AtomicBoolean CURRENT = new AtomicBoolean(true);
  private static boolean retireOnDownload;
  private static int connections, writes, reads;

  private static Grant grant(Object code, String owner, Object organization) {
    return new Grant(code, "a".repeat(64), owner, organization, "\"1\"", true);
  }

  private static PasswordBackupApproval approve(Purpose purpose, Grant grant) throws Exception {
    return PasswordBackupApproval.admit(BACKUP, purpose, STATE, VERIFIER, OWNER, grant, CURRENT::get);
  }

  private void backup() throws Exception {
    URL.setURLStreamHandlerFactory(scheme -> "https".equals(scheme) ? new URLStreamHandler() {
      @Override protected URLConnection openConnection(URL url) {
        connections++;
        return new BackupEndpoint(url);
      }
    } : null);
    rejects("another account's approval", null, () -> approve(Purpose.SAVE, grant(PROOF, "account-2", "organization-1")));
    rejects("another organization's approval", null, () -> approve(Purpose.SAVE, grant(PROOF, "account-1", "organization-2")));
    rejects("an approval without an organization", null, () -> approve(Purpose.SAVE, grant(PROOF, "account-1", null)));
    rejects("a malformed proof", null, () -> approve(Purpose.SAVE, grant("pbackup_short", "account-1", "organization-1")));
    rejects("a verification that carries a proof", null, () -> approve(Purpose.VERIFY, grant(PROOF, "account-1", "organization-1")));
    PasswordBackupApproval verified = approve(Purpose.VERIFY, grant(null, "account-1", "organization-1"));
    check("a verification names the current owner", "account-1".equals(verified.ownerId()) && "organization-1".equals(verified.organizationId()));
    rejects("a verification transfers nothing", null, () -> verified.run(null, null));
    rejects("a native verification for another account", null, () -> approve(Purpose.VERIFY, grant(null, "account-2", "organization-1")));
    rejects("a native verification for another organization", null, () -> approve(Purpose.VERIFY, grant(null, "account-1", "organization-2")));
    rejects("a transfer without an operation proof", null, () -> approve(Purpose.SAVE, grant(null, "account-1", "organization-1")));
    var nativeVerified = approve(Purpose.VERIFY, new Grant(null, "a".repeat(64), "account-1", "organization-1", null, false));
    check("native verification names the current owner", OWNER.accountId().equals(nativeVerified.ownerId()) && OWNER.organizationId().equals(nativeVerified.organizationId()));
    rejects("native verification cannot transfer the backup", null, () -> nativeVerified.run(null, null));
    check("verification and refused grants never connect to the backup endpoint", connections == 0);
    CURRENT.set(false);
    rejects("an approval for a replaced account", null, () -> approve(Purpose.SAVE, grant(PROOF, "account-1", "organization-1")));
    CURRENT.set(true);
    PasswordBackupApproval stale = approve(Purpose.SAVE, grant(PROOF, "account-1", "organization-1"));
    CURRENT.set(false);
    rejects("a stale approval", null, () -> stale.run(stale.revision(), SNAPSHOT));
    CURRENT.set(true);
    PasswordBackupApproval save = approve(Purpose.SAVE, grant(PROOF, "account-1", "organization-1"));
    check("a current approval saves once", save.run(save.revision(), SNAPSHOT).status() == 204);
    rejects("a spent approval", null, () -> save.run(save.revision(), SNAPSHOT));
    check("one approval wrote once", writes == 1);
    PasswordBackupApproval read = approve(Purpose.READ, grant(PROOF, "account-1", "organization-1"));
    retireOnDownload = true;
    rejects("a read whose account changed while downloading", null, () -> read.run(null, null));
    check("the retired read reached the cloud once", reads == 1 && !read.current());
  }

  private static final class BackupEndpoint extends HttpsURLConnection {
    private final ByteArrayOutputStream sent = new ByteArrayOutputStream();

    BackupEndpoint(URL url) { super(url); }

    @Override public int getResponseCode() {
      boolean bound = BACKUP.toString().equals(url.toString()) && !getInstanceFollowRedirects()
          && ("Bearer " + PROOF).equals(getRequestProperty("Authorization"))
          && STATE.equals(getRequestProperty("X-Backup-State")) && VERIFIER.equals(getRequestProperty("X-Backup-Verifier"));
      if (!bound) return 401;
      if ("PUT".equals(method) && "\"1\"".equals(getRequestProperty("If-Match")) && Arrays.equals(SNAPSHOT, sent.toByteArray())) {
        writes++;
        return 204;
      }
      if (!"GET".equals(method)) return 400;
      reads++;
      return 200;
    }

    @Override public OutputStream getOutputStream() { return sent; }
    @Override public String getHeaderField(String name) { return "ETag".equals(name) ? "\"1\"" : null; }
    @Override public String getContentType() { return "application/octet-stream"; }
    @Override public long getContentLengthLong() { return SNAPSHOT.length; }
    @Override public InputStream getInputStream() {
      return new ByteArrayInputStream(SNAPSHOT) {
        @Override public synchronized int read(byte[] buffer, int start, int length) {
          int count = super.read(buffer, start, length);
          if (retireOnDownload && count == -1) CURRENT.set(false);
          return count;
        }
      };
    }
    @Override public void connect() {}
    @Override public void disconnect() {}
    @Override public boolean usingProxy() { return false; }
    @Override public String getCipherSuite() { return ""; }
    @Override public Certificate[] getLocalCertificates() { return null; }
    @Override public Certificate[] getServerCertificates() { return null; }
  }

  private String report() {
    StringBuilder json = new StringBuilder("{\"checks\":").append(checks).append(",\"failed\":[");
    for (int index = 0; index < failed.size(); index++) {
      if (index > 0) json.append(',');
      json.append('"').append(failed.get(index).replace("\\", "\\\\").replace("\"", "\\\"")).append('"');
    }
    return json.append("]}").toString();
  }

  public static void main(String[] args) throws Exception {
    PasswordPolicyCheck run = new PasswordPolicyCheck();
    for (String group : args) {
      switch (group) {
        case "generator" -> run.generator();
        case "fill" -> run.fills();
        case "save" -> run.saves();
        case "match" -> run.matching();
        case "offer" -> run.offers();
        case "editor" -> run.editor();
        case "backup" -> run.backup();
        default -> throw new IllegalArgumentException("no check group " + group);
      }
    }
    System.out.println(run.report());
  }
}
