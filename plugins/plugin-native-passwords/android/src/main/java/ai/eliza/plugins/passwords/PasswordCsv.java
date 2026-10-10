package ai.eliza.plugins.passwords;

import ai.eliza.plugins.securestore.nativeonly.PasswordFacets;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Plain-Java CSV export and import for the password vault (no Android framework), so the
 * parsing and binding rules are JVM-testable. Export writes the common
 * {@code name,url,username,password,note} layout. Import reads exports from browsers and
 * password managers by header name and binds each row to exactly one HTTPS origin derived
 * from its URL (scheme, host and non-default port; path, query and fragment are dropped).
 * App ({@code android://}) bindings are never created from a file: they come only from a
 * verified save capture. Values are never logged or included in exception messages.
 */
public final class PasswordCsv {
  private PasswordCsv() {}

  public static final int MAX_BYTES = 2 * 1024 * 1024, MAX_ROWS = 1000;
  public static final String HEADER = "name,url,username,password,note";
  /** Same bounds as PasswordVaultStore (kept equal by policy.node.mjs / transfer.node.mjs). */
  public static final int MAX_LABEL = 200, MAX_USERNAME = 1024, MAX_PASSWORD = 16384;

  /** Why an import row was not added. Fixed codes; never contains row values. */
  public enum Skip { NO_PASSWORD, NO_WEBSITE, NOT_HTTPS, APP_BINDING, INVALID_WEBSITE, TOO_LONG, DUPLICATE, ALREADY_SAVED }

  /** One parsed row. {@link #origin} is the exact binding the review shows. */
  public static final class Row {
    public final String label, origin, username;
    final char[] password;
    public final Skip skip;
    Row(String label, String origin, String username, char[] password, Skip skip) { this.label = label; this.origin = origin; this.username = username; this.password = password; this.skip = skip; }
    public boolean importable() { return skip == null; }
    public String password() { return password == null ? null : new String(password); }
    /** Overwrite the in-memory secret once the row has been saved or abandoned. */
    public void wipe() { if (password != null) java.util.Arrays.fill(password, '\0'); }
  }

  public static final class Import {
    public final List<Row> rows;
    Import(List<Row> rows) { this.rows = Collections.unmodifiableList(rows); }
    public List<Row> importable() { List<Row> out = new ArrayList<>(); for (Row row : rows) if (row.importable()) out.add(row); return out; }
    public int skipped() { int count = 0; for (Row row : rows) if (!row.importable()) count++; return count; }
    public Map<Skip, Integer> reasons() { Map<Skip, Integer> out = new LinkedHashMap<>(); for (Row row : rows) if (!row.importable()) out.merge(row.skip, 1, Integer::sum); return out; }
    /** Distinct origins that will receive a new entry, in file order. */
    public List<String> origins() { List<String> out = new ArrayList<>(); for (Row row : importable()) if (!out.contains(row.origin)) out.add(row.origin); return out; }
    public void wipe() { for (Row row : rows) row.wipe(); }
  }

  /** An exported entry: label, username, facets and the secret, supplied only by native code. */
  public static final class Entry {
    final String label, username, password; final List<String> facets;
    public Entry(String label, String username, List<String> facets, String password) { this.label = label; this.username = username; this.facets = facets; this.password = password; }
  }

  static String quote(String value) {
    String text = value == null ? "" : value;
    boolean needs = text.isEmpty() ? false : text.indexOf(',') >= 0 || text.indexOf('"') >= 0 || text.indexOf('\n') >= 0 || text.indexOf('\r') >= 0
      || Character.isWhitespace(text.charAt(0)) || Character.isWhitespace(text.charAt(text.length() - 1));
    return needs ? '"' + text.replace("\"", "\"\"") + '"' : text;
  }

  /**
   * One row per binding, so every website and app keeps its own exact entry. Rows for app
   * bindings use the {@code android://<sha256>@<package>} form other managers also export.
   */
  public static byte[] export(List<Entry> entries) {
    StringBuilder out = new StringBuilder(HEADER).append("\r\n");
    for (Entry entry : entries) for (String facet : entry.facets)
      out.append(quote(entry.label)).append(',').append(quote(facet)).append(',').append(quote(entry.username)).append(',')
        .append(quote(entry.password)).append(',').append("\r\n");
    byte[] bytes = out.toString().getBytes(StandardCharsets.UTF_8);
    out.setLength(0);
    return bytes;
  }

  /** RFC 4180 records: quoted fields, doubled quotes, CRLF or LF, embedded newlines. */
  static List<List<String>> records(String text) throws IOException {
    List<List<String>> records = new ArrayList<>();
    List<String> record = new ArrayList<>();
    StringBuilder field = new StringBuilder();
    boolean quoted = false, closedQuote = false, any = false;
    int start = text.startsWith("﻿") ? 1 : 0;
    for (int i = start; i < text.length(); i++) {
      char c = text.charAt(i);
      if (quoted) {
        if (c == '"') { if (i + 1 < text.length() && text.charAt(i + 1) == '"') { field.append('"'); i++; } else { quoted = false; closedQuote = true; } }
        else field.append(c);
        continue;
      }
      if (closedQuote && c != ',' && c != '\n' && c != '\r') throw new IOException("The file is not valid CSV");
      if (c == '"' && field.length() == 0) { quoted = true; any = true; }
      else if (c == ',') { record.add(field.toString()); field.setLength(0); closedQuote = false; any = true; }
      else if (c == '\n' || c == '\r') {
        if (c == '\r' && i + 1 < text.length() && text.charAt(i + 1) == '\n') i++;
        if (any || field.length() > 0) { record.add(field.toString()); records.add(record); }
        record = new ArrayList<>(); field.setLength(0); closedQuote = false; any = false;
        if (records.size() > MAX_ROWS + 1) throw new IOException("The file has too many rows");
      }
      else { if (c == '"') throw new IOException("The file is not valid CSV"); field.append(c); any = true; }
    }
    if (quoted) throw new IOException("The file is not valid CSV");
    if (any || field.length() > 0) { record.add(field.toString()); records.add(record); }
    if (records.size() > MAX_ROWS + 1) throw new IOException("The file has too many rows");
    return records;
  }

  private static int column(List<String> header, String... names) {
    for (String name : names) for (int i = 0; i < header.size(); i++) if (header.get(i).trim().toLowerCase(Locale.ROOT).equals(name)) return i;
    return -1;
  }
  private static String cell(List<String> record, int index) { return index < 0 || index >= record.size() ? "" : record.get(index); }

  /** Exact HTTPS origin for an imported URL; the review shows this binding. */
  public static String origin(String raw) throws IOException {
    String value = raw == null ? "" : raw.trim();
    if (value.isEmpty()) throw new IOException("NO_WEBSITE");
    if (value.regionMatches(true, 0, "android://", 0, 10) || value.regionMatches(true, 0, "androidapp://", 0, 13)) throw new IOException("APP_BINDING");
    URI uri;
    try { uri = new URI(value); } catch (Exception invalid) { throw new IOException("INVALID_WEBSITE"); }
    if (uri.getScheme() == null) {
      // A bare host ("example.com/login") is taken as HTTPS, like typing it in the browser.
      try { uri = new URI("https://" + value); } catch (Exception invalid) { throw new IOException("INVALID_WEBSITE"); }
    }
    if (!"https".equalsIgnoreCase(uri.getScheme())) throw new IOException("NOT_HTTPS");
    if (uri.getHost() == null || uri.getRawUserInfo() != null) throw new IOException("INVALID_WEBSITE");
    try { return PasswordFacets.web(new URI("https", null, uri.getHost(), uri.getPort(), null, null, null).toASCIIString()); }
    catch (Exception invalid) { throw new IOException("INVALID_WEBSITE"); }
  }

  /**
   * Parses an export. {@code existing} holds {@code origin + "\n" + username} keys already in
   * the vault; matching rows are skipped rather than overwriting a saved password.
   */
  public static Import parse(byte[] bytes, Set<String> existing) throws IOException {
    if (bytes == null || bytes.length == 0) throw new IOException("The file is empty");
    if (bytes.length > MAX_BYTES) throw new IOException("The file is larger than 2 MB");
    String text;
    try { text = StandardCharsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes)).toString(); }
    catch (Exception invalid) { throw new IOException("The file is not UTF-8 text"); }
    List<List<String>> records = records(text);
    if (records.isEmpty()) throw new IOException("The file is empty");
    List<String> header = records.get(0);
    int url = column(header, "url", "login_uri", "website", "uri", "login url", "web site"),
      password = column(header, "password", "login_password"),
      username = column(header, "username", "login_username", "user", "login", "user name"),
      email = column(header, "email", "e-mail"),
      name = column(header, "name", "title");
    if (url < 0 || password < 0) throw new IOException("The file has no url and password columns");
    List<Row> rows = new ArrayList<>();
    Set<String> seen = new HashSet<>();
    for (int r = 1; r < records.size(); r++) {
      List<String> record = records.get(r);
      String secret = cell(record, password), user = cell(record, username);
      if (user.isEmpty()) user = cell(record, email);
      String label = cell(record, name).trim();
      Skip skip = null; String origin = null;
      if (secret.isEmpty()) skip = Skip.NO_PASSWORD;
      else if (secret.length() > MAX_PASSWORD || user.length() > MAX_USERNAME) skip = Skip.TOO_LONG;
      else {
        try { origin = origin(cell(record, url)); }
        catch (IOException reason) { skip = Skip.valueOf(reason.getMessage()); }
      }
      if (origin != null && label.isEmpty()) label = URI.create(origin).getHost();
      if (label.length() > MAX_LABEL) skip = Skip.TOO_LONG;
      if (skip == null) {
        String key = origin + "\n" + user;
        if (existing != null && existing.contains(key)) skip = Skip.ALREADY_SAVED;
        else if (!seen.add(key)) skip = Skip.DUPLICATE;
      }
      rows.add(new Row(label, skip == null ? origin : (origin == null ? "" : origin), user, skip == null ? secret.toCharArray() : null, skip));
    }
    return new Import(rows);
  }

  /** Review lines: the exact origins that will be bound, then skip counts. No secrets. */
  public static String review(Import parsed) {
    StringBuilder out = new StringBuilder();
    List<String> origins = parsed.origins();
    int count = parsed.importable().size();
    out.append(count).append(count == 1 ? " password" : " passwords").append(" will be added. Each is used only on the exact website shown:\n");
    for (String origin : origins) out.append("\n").append(origin);
    Map<Skip, Integer> reasons = parsed.reasons();
    if (!reasons.isEmpty()) {
      out.append("\n\nNot imported:");
      for (Map.Entry<Skip, Integer> reason : reasons.entrySet()) out.append("\n").append(reason.getValue()).append(" · ").append(describe(reason.getKey()));
    }
    return out.toString();
  }

  public static String describe(Skip skip) {
    switch (skip) {
      case NO_PASSWORD: return "no password";
      case NO_WEBSITE: return "no website";
      case NOT_HTTPS: return "not an HTTPS website";
      case APP_BINDING: return "app sign-ins (save them from the app instead)";
      case INVALID_WEBSITE: return "website address not recognised";
      case TOO_LONG: return "name, username or password too long";
      case DUPLICATE: return "repeated in the file";
      default: return "already saved for that website and username";
    }
  }
}
