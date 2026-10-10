import ai.eliza.plugins.passwords.PasswordCsv;
import ai.eliza.plugins.passwords.PasswordCsv.Import;
import ai.eliza.plugins.passwords.PasswordCsv.Row;
import ai.eliza.plugins.passwords.PasswordCsv.Skip;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** JVM tests for vault CSV export/import with synthetic values only. */
public final class PasswordCsvTest {
  private static int checks;
  private static void check(boolean value) { checks++; if (!value) throw new AssertionError("Check " + checks); }
  private static void equal(Object expected, Object actual) { checks++; if (expected == null ? actual != null : !expected.equals(actual)) throw new AssertionError("Check " + checks + ": expected " + expected + " got " + actual); }
  private interface Failing { void run() throws Exception; }
  private static void rejects(String message, Failing body) {
    checks++;
    try { body.run(); } catch (IOException expected) { if (!expected.getMessage().equals(message)) throw new AssertionError("Check " + checks + ": " + expected.getMessage()); return; }
    catch (Exception other) { throw new AssertionError("Check " + checks + ": " + other); }
    throw new AssertionError("Check " + checks + " should have been rejected");
  }
  private static byte[] utf8(String text) { return text.getBytes(StandardCharsets.UTF_8); }
  private static Import parse(String text) throws IOException { return PasswordCsv.parse(utf8(text), Collections.emptySet()); }

  public static void main(String[] args) throws Exception {
    // Exact-origin binding: scheme, host and non-default port only.
    equal("https://example.com", PasswordCsv.origin("https://example.com/login?next=/home#top"));
    equal("https://example.com", PasswordCsv.origin("HTTPS://EXAMPLE.COM:443/"));
    equal("https://example.com:8443", PasswordCsv.origin("https://example.com:8443/a"));
    equal("https://accounts.example.com", PasswordCsv.origin("accounts.example.com/signin"));
    equal("https://example.com", PasswordCsv.origin("  https://example.com.  "));
    rejects("NOT_HTTPS", () -> PasswordCsv.origin("http://example.com/"));
    rejects("NOT_HTTPS", () -> PasswordCsv.origin("ftp://example.com/"));
    rejects("APP_BINDING", () -> PasswordCsv.origin("android://abc@com.example.app/"));
    rejects("APP_BINDING", () -> PasswordCsv.origin("androidapp://com.example.app"));
    rejects("INVALID_WEBSITE", () -> PasswordCsv.origin("https://user:pw@example.com/"));
    rejects("INVALID_WEBSITE", () -> PasswordCsv.origin("https://exa mple.com/"));
    rejects("NO_WEBSITE", () -> PasswordCsv.origin(""));

    // Chrome/Google Password Manager layout, with a BOM, CRLF and quoted fields.
    Import chrome = parse("﻿name,url,username,password,note\r\n"
      + "Example,https://example.com/login,alice@example.com,\"pa,ss\"\"word\",\r\n"
      + "Bank,https://bank.example:8443/,bob,\"line1\nline2\",note\r\n"
      + "Plain,http://legacy.example/,carol,secret3,\r\n"
      + "App,android://abc@com.example.app/,dave,secret4,\r\n"
      + "Empty,https://empty.example/,erin,,\r\n"
      + "NoSite,,frank,secret6,\r\n");
    equal(6, chrome.rows.size());
    List<Row> ok = chrome.importable();
    equal(2, ok.size());
    equal("https://example.com", ok.get(0).origin); equal("alice@example.com", ok.get(0).username); equal("pa,ss\"word", ok.get(0).password()); equal("Example", ok.get(0).label);
    equal("https://bank.example:8443", ok.get(1).origin); equal("line1\nline2", ok.get(1).password());
    equal(Skip.NOT_HTTPS, chrome.rows.get(2).skip); equal(Skip.APP_BINDING, chrome.rows.get(3).skip);
    equal(Skip.NO_PASSWORD, chrome.rows.get(4).skip); equal(Skip.NO_WEBSITE, chrome.rows.get(5).skip);
    check(chrome.rows.get(2).password() == null);
    equal(4, chrome.skipped());
    equal(Arrays.asList("https://example.com", "https://bank.example:8443"), chrome.origins());
    String review = PasswordCsv.review(chrome);
    check(review.contains("2 passwords will be added")); check(review.contains("\nhttps://example.com")); check(review.contains("\nhttps://bank.example:8443"));
    check(review.contains("1 · not an HTTPS website")); check(review.contains("1 · app sign-ins"));
    // The review never contains secrets or usernames.
    check(!review.contains("pa,ss")); check(!review.contains("line1")); check(!review.contains("alice")); check(!review.contains("secret"));

    // Bitwarden and Firefox layouts are read by header name; email fills a missing username.
    Import bitwarden = parse("folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,,login,Mail,,,0,https://mail.example/inbox,me,mailpass,\n");
    equal(1, bitwarden.importable().size()); equal("https://mail.example", bitwarden.importable().get(0).origin); equal("mailpass", bitwarden.importable().get(0).password());
    Import firefox = parse("\"url\",\"username\",\"password\",\"httpRealm\",\"formActionOrigin\",\"guid\"\n\"https://shop.example\",\"sam\",\"shoppass\",,\"https://shop.example\",\"{x}\"\n");
    equal("shop.example", firefox.importable().get(0).label);
    Import proton = parse("name,url,email,username,password,note,totp\nWork,https://work.example/,pat@work.example,,workpass,,\n");
    equal("pat@work.example", proton.importable().get(0).username);

    // Duplicates in the file and entries already saved are skipped, never overwritten.
    Set<String> existing = new HashSet<>(Collections.singletonList("https://example.com\nalice"));
    Import dupes = PasswordCsv.parse(utf8("url,username,password\nhttps://example.com/a,alice,one\nhttps://example.com/b,bob,two\nhttps://example.com/c,bob,three\n"), existing);
    equal(Skip.ALREADY_SAVED, dupes.rows.get(0).skip); check(dupes.rows.get(1).importable()); equal(Skip.DUPLICATE, dupes.rows.get(2).skip);

    // Bounds and malformed input.
    StringBuilder longPassword = new StringBuilder(); for (int i = 0; i < PasswordCsv.MAX_PASSWORD + 1; i++) longPassword.append('x');
    equal(Skip.TOO_LONG, parse("url,username,password\nhttps://a.example,u," + longPassword + "\n").rows.get(0).skip);
    rejects("The file has no url and password columns", () -> parse("name,user\nx,y\n"));
    rejects("The file is not valid CSV", () -> parse("url,username,password\n\"https://a.example,u,p\n"));
    rejects("The file is empty", () -> PasswordCsv.parse(new byte[0], Collections.emptySet()));
    rejects("The file is larger than 2 MB", () -> PasswordCsv.parse(new byte[PasswordCsv.MAX_BYTES + 1], Collections.emptySet()));
    rejects("The file is not UTF-8 text", () -> PasswordCsv.parse(new byte[] {'u', 'r', 'l', (byte) 0xff, (byte) 0xfe}, Collections.emptySet()));
    StringBuilder many = new StringBuilder("url,username,password\n"); for (int i = 0; i <= PasswordCsv.MAX_ROWS + 1; i++) many.append("https://h").append(i).append(".example,u,p\n");
    rejects("The file has too many rows", () -> parse(many.toString()));

    // All approved destinations remain visible even beyond the old 40-origin cutoff.
    StringBuilder destinations = new StringBuilder("url,username,password\n");
    for (int i = 0; i < 41; i++) destinations.append("https://h").append(i).append(".example,u,p\n");
    String completeReview = PasswordCsv.review(parse(destinations.toString()));
    check(completeReview.contains("\nhttps://h40.example"));
    equal(Skip.TOO_LONG, parse("name,url,password\n" + "x".repeat(201) + ",https://a.example,p\n").rows.get(0).skip);
    rejects("The file is not valid CSV", () -> parse("url,password\nhttps://a.example,\"secret\"suffix\n"));
    rejects("The file is not valid CSV", () -> parse("url,password\nhttps://a.example,se\"cret\n"));

    // Wiping overwrites the in-memory secret.
    Row wiped = parse("url,username,password\nhttps://w.example,u,wipe-me\n").importable().get(0);
    wiped.wipe(); check(!"wipe-me".equals(wiped.password()));

    // Export: one row per binding, RFC 4180 quoting, and a lossless round trip for web rows.
    byte[] exported = PasswordCsv.export(Arrays.asList(
      new PasswordCsv.Entry("Example, Inc", "alice", Arrays.asList("https://example.com", "https://login.example.com"), "p\"a,ss\nword"),
      new PasswordCsv.Entry("App", "dave", Collections.singletonList("android://" + "a".repeat(64) + "@com.example.app"), " spaced ")));
    String text = new String(exported, StandardCharsets.UTF_8);
    check(text.startsWith(PasswordCsv.HEADER + "\r\n"));
    check(text.contains("\"Example, Inc\",https://example.com,alice,\"p\"\"a,ss\nword\",\r\n"));
    check(text.contains("\"Example, Inc\",https://login.example.com,alice,"));
    check(text.contains("App,android://" + "a".repeat(64) + "@com.example.app,dave,\" spaced \",\r\n"));
    Import round = PasswordCsv.parse(exported, Collections.emptySet());
    equal(3, round.rows.size()); equal(2, round.importable().size());
    equal("p\"a,ss\nword", round.importable().get(0).password()); equal("https://login.example.com", round.importable().get(1).origin);
    equal(Skip.APP_BINDING, round.rows.get(2).skip);

    System.out.println(checks + " assertions passed");
  }
}
