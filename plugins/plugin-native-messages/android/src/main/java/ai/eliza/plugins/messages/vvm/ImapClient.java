package ai.eliza.plugins.messages.vvm;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * The part of IMAP4rev1 a voicemail mailbox needs, over a socket the caller connected (and, for TLS,
 * already handshook): LOGIN, CAPABILITY, SELECT, UID SEARCH, UID FETCH of flags, envelope, body
 * structure and one body part, UID STORE, EXPUNGE, GETQUOTAROOT and LOGOUT.
 *
 * Everything read from the server is bounded: the bytes of one response outside its literals
 * ({@link #MAX_LINE}), the literals buffered in one response ({@link #MAX_LITERAL}), nesting depth,
 * values per response, untagged responses per command, and the one streamed body literal by the
 * limit its caller names. Every read has the socket's timeout and the whole session a deadline. A
 * broken bound or an unparsable response closes the session; it is never resynchronised. No server
 * text, credential or message content is put in an exception or a log.
 */
public final class ImapClient implements Closeable {
 public static final int MAX_LINE = 16 * 1024, MAX_LITERAL = 64 * 1024, MAX_DEPTH = 16, MAX_VALUES = 4096, MAX_UNTAGGED = 4096, MAX_UIDS = 2000;

 /** Why a session failed, without any server text. */
 public enum Failure { AUTHENTICATION, REFUSED, PROTOCOL, LIMIT, TIMEOUT, CONSUMER }
 public static final class ImapException extends IOException {
  private static final long serialVersionUID = 1L;
  public final Failure failure;
  ImapException(Failure failure, String what) { super(what); this.failure = failure; }
 }
 /** Receives the bytes of one body part exactly as the server sent them (still transfer-encoded). */
 public interface BodyConsumer { void accept(InputStream body) throws IOException; }

 /** One untagged response: its values, or for a status response (OK, NO, BAD, BYE, PREAUTH) only its text. */
 private static final class Untagged { List<Object> values; String status, text; }
 /** One message of a FETCH response, by data item name (upper case). */
 public static final class Fetched {
  public final Map<String, Object> items = new HashMap<>();
  public long uid() { Object uid = items.get("UID"); return uid instanceof String ? positive((String) uid) : -1; }
  /** The message's flags in lower case, e.g. {@code \seen}. */
  public Set<String> flags() {
   Set<String> flags = new HashSet<>();
   Object list = items.get("FLAGS");
   if (list instanceof List) for (Object flag : (List<?>) list) if (flag instanceof String) flags.add(((String) flag).toLowerCase(Locale.ROOT));
   return flags;
  }
 }

 private final Socket socket; private final InputStream in; private final OutputStream out; private final Closeable release;
 private final long deadline;
 private int tag, lineBytes, literalBytes, values;
 private BodyConsumer bodyConsumer; private long bodyLimit; private boolean bodyDelivered;
 private boolean closed;

 /**
  * Takes over a connected socket and reads the server greeting.
  * @param readMillis the longest one read may wait for the server
  * @param sessionMillis the longest the whole session may last
  * @param release run once on {@link #close} after the socket is closed (for example to give back a requested network); may be null
  */
 public ImapClient(Socket socket, int readMillis, long sessionMillis, Closeable release) throws IOException {
  this.socket = socket; this.release = release;
  this.deadline = System.nanoTime() + sessionMillis * 1_000_000L;
  try {
   socket.setSoTimeout(readMillis);
   in = new BufferedInputStream(socket.getInputStream(), 8192); out = socket.getOutputStream();
   beginResponse();
   if (!"*".equals(atom())) throw protocol();
   String status = atom().toUpperCase(Locale.ROOT);
   restOfLine();
   if (!status.equals("OK")) throw new ImapException(Failure.REFUSED, "IMAP server refused the connection");
  } catch (IOException | RuntimeException failed) { close(); throw translate(failed); }
 }

 public Set<String> capability() throws IOException {
  Set<String> capabilities = new HashSet<>();
  for (Untagged response : command("CAPABILITY"))
   if (named(response, "CAPABILITY")) for (Object value : response.values) if (value instanceof String) capabilities.add(((String) value).toUpperCase(Locale.ROOT));
  capabilities.remove("CAPABILITY");
  return capabilities;
 }

 /** LOGIN with the carrier-issued account. A NO answer is {@link Failure#AUTHENTICATION}. */
 public void login(String user, String password) throws IOException {
  try { command("LOGIN " + quoted(user) + " " + quoted(password)); }
  catch (ImapException refused) { throw refused.failure == Failure.REFUSED ? new ImapException(Failure.AUTHENTICATION, "IMAP login refused") : refused; }
 }

 /** Selects a mailbox read-write and returns its UIDVALIDITY, or -1 when the server named none. */
 public long select(String mailbox) throws IOException {
  long validity = -1;
  for (Untagged response : command("SELECT " + quoted(mailbox))) {
   if (response.status == null) continue;
   String text = response.text.toUpperCase(Locale.ROOT);
   int at = text.indexOf("[UIDVALIDITY ");
   if (at < 0) continue;
   int end = text.indexOf(']', at);
   if (end > 0) validity = positive(text.substring(at + 13, end).trim());
  }
  return validity;
 }

 /** Every UID in the selected mailbox, ascending. More than {@link #MAX_UIDS} fails the session. */
 public List<Long> uidSearchAll() throws IOException {
  TreeSet<Long> uids = new TreeSet<>();
  for (Untagged response : command("UID SEARCH ALL")) {
   if (!named(response, "SEARCH")) continue;
   for (int i = 1; i < response.values.size(); i++) {
    Object value = response.values.get(i);
    long uid = value instanceof String ? positive((String) value) : -1;
    if (uid < 0) throw closing(protocol());
    uids.add(uid);
    if (uids.size() > MAX_UIDS) throw closing(new ImapException(Failure.LIMIT, "Too many messages in the mailbox"));
   }
  }
  return new ArrayList<>(uids);
 }

 /** UID FETCH of the named data items for a set of UIDs; one {@link Fetched} per message the server answered for. */
 public List<Fetched> uidFetch(Collection<Long> uids, String items) throws IOException {
  List<Fetched> fetched = new ArrayList<>();
  if (uids.isEmpty()) return fetched;
  for (Untagged response : command("UID FETCH " + set(uids) + " (" + items + ")")) {
   if (response.values == null || response.values.size() < 3 || !(response.values.get(1) instanceof String)
     || !"FETCH".equalsIgnoreCase((String) response.values.get(1)) || !(response.values.get(2) instanceof List)) continue;
   List<?> pairs = (List<?>) response.values.get(2);
   Fetched message = new Fetched();
   for (int i = 0; i + 1 < pairs.size(); i += 2) {
    if (!(pairs.get(i) instanceof String)) throw closing(protocol());
    message.items.put(((String) pairs.get(i)).toUpperCase(Locale.ROOT), pairs.get(i + 1));
   }
   fetched.add(message);
  }
  return fetched;
 }

 /**
  * Streams one body part ({@code BODY.PEEK[section]}, so reading does not mark the message seen) to
  * the consumer. A part larger than {@code maxBytes} as sent fails the session before any of it is
  * delivered. Returns false when the server sent no such part.
  */
 public boolean fetchBody(long uid, String section, long maxBytes, BodyConsumer consumer) throws IOException {
  if (uid <= 0 || !section.matches("[0-9]{1,3}(\\.[0-9]{1,3}){0,7}") || maxBytes <= 0) throw new IllegalArgumentException("Invalid body request");
  bodyConsumer = consumer; bodyLimit = maxBytes; bodyDelivered = false;
  try { command("UID FETCH " + uid + " (UID BODY.PEEK[" + section + "])"); return bodyDelivered; }
  finally { bodyConsumer = null; }
 }

 /** Adds one flag ({@code \Seen} or {@code \Deleted}) to messages. */
 public void addFlag(Collection<Long> uids, String flag) throws IOException {
  if (!flag.matches("\\\\[A-Za-z]{1,16}")) throw new IllegalArgumentException("Invalid flag");
  if (!uids.isEmpty()) command("UID STORE " + set(uids) + " +FLAGS.SILENT (" + flag + ")");
 }

 /** Removes messages flagged \Deleted: only the named ones when the server has UIDPLUS, otherwise every flagged one. */
 public void expunge(Collection<Long> uids, boolean uidPlus) throws IOException {
  if (uids.isEmpty()) return;
  command(uidPlus ? "UID EXPUNGE " + set(uids) : "EXPUNGE");
 }

 /** The mailbox's STORAGE quota as the server counts it ({@code {used, limit}}), or null when it reports none. */
 public long[] quota(String mailbox) throws IOException {
  for (Untagged response : command("GETQUOTAROOT " + quoted(mailbox))) {
   if (!named(response, "QUOTA") || response.values.size() < 3 || !(response.values.get(2) instanceof List)) continue;
   List<?> resources = (List<?>) response.values.get(2);
   for (int i = 0; i + 2 < resources.size(); i += 3) {
    if (!(resources.get(i) instanceof String) || !"STORAGE".equalsIgnoreCase((String) resources.get(i))) continue;
    long used = resources.get(i + 1) instanceof String ? count((String) resources.get(i + 1)) : -1, limit = resources.get(i + 2) instanceof String ? count((String) resources.get(i + 2)) : -1;
    if (used >= 0 && limit > 0) return new long[] { used, limit };
   }
  }
  return null;
 }

 /** Says goodbye when the session is still usable, then closes. Never throws. */
 public void logout() {
  if (!closed) try { command("LOGOUT"); } catch (IOException | RuntimeException ignored) { /* closing anyway */ }
  close();
 }

 @Override public void close() {
  if (closed) return;
  closed = true;
  try { socket.close(); } catch (IOException ignored) { /* nothing to recover */ }
  if (release != null) try { release.close(); } catch (IOException ignored) { /* nothing to recover */ }
 }

 // ---- Commands ------------------------------------------------------------------------------

 private List<Untagged> command(String line) throws IOException {
  if (closed) throw new ImapException(Failure.PROTOCOL, "IMAP session is closed");
  try {
   checkDeadline();
   String id = "a" + (++tag);
   out.write((id + " " + line + "\r\n").getBytes(StandardCharsets.UTF_8));
   out.flush();
   List<Untagged> untagged = new ArrayList<>();
   while (true) {
    beginResponse();
    String first = atom();
    if (first.equals("*")) {
     if (untagged.size() >= MAX_UNTAGGED) throw new ImapException(Failure.LIMIT, "Too many IMAP responses");
     untagged.add(untagged());
    } else if (first.equals(id)) {
     String status = atom().toUpperCase(Locale.ROOT);
     restOfLine();
     if (status.equals("OK")) return untagged;
     if (status.equals("NO") || status.equals("BAD")) { if (status.equals("BAD")) close(); throw new ImapException(Failure.REFUSED, "IMAP command refused"); }
     throw protocol();
    } else throw protocol(); // a continuation request or a foreign tag: this client never sends literals
   }
  } catch (ImapException refused) {
   if (refused.failure != Failure.REFUSED) close();
   throw refused;
  } catch (IOException | RuntimeException failed) { close(); throw translate(failed); }
 }

 private Untagged untagged() throws IOException {
  Untagged response = new Untagged();
  String name = atom();
  String upper = name.toUpperCase(Locale.ROOT);
  if (upper.equals("OK") || upper.equals("NO") || upper.equals("BAD") || upper.equals("BYE") || upper.equals("PREAUTH")) {
   response.status = upper; response.text = restOfLine();
   return response;
  }
  response.values = new ArrayList<>();
  response.values.add(name);
  String previous = name;
  while (true) {
   int c = read();
   if (c == ' ') continue;
   if (c == '\r') { if (read() != '\n') throw protocol(); return response; }
   Object value = value(c, 0, previous);
   response.values.add(value);
   previous = value instanceof String ? (String) value : null;
  }
 }
 private static boolean named(Untagged response, String name) {
  return response.values != null && !response.values.isEmpty() && response.values.get(0) instanceof String && name.equalsIgnoreCase((String) response.values.get(0));
 }

 // ---- Response reader -----------------------------------------------------------------------

 private void beginResponse() { lineBytes = 0; literalBytes = 0; values = 0; }
 private int read() throws IOException {
  int c = in.read();
  if (c < 0) throw new ImapException(Failure.PROTOCOL, "IMAP connection closed");
  if (++lineBytes > MAX_LINE) throw new ImapException(Failure.LIMIT, "IMAP response too long");
  if ((lineBytes & 0xff) == 0) checkDeadline();
  return c;
 }
 private int peek() throws IOException { in.mark(1); int c = in.read(); in.reset(); return c; }
 private void checkDeadline() throws IOException { if (System.nanoTime() - deadline > 0) throw new ImapException(Failure.TIMEOUT, "IMAP session took too long"); }

 /** The space-terminated word at the start of a response (a tag, {@code *}, or a status). */
 private String atom() throws IOException {
  StringBuilder text = new StringBuilder();
  while (true) {
   int next = peek();
   if (next == ' ') { read(); if (text.length() > 0) return text.toString(); continue; }
   if (next == '\r' || next == '\n' || next < 0) { if (text.length() == 0) throw protocol(); return text.toString(); }
   text.append((char) read());
  }
 }
 private String restOfLine() throws IOException {
  StringBuilder text = new StringBuilder();
  while (true) {
   int c = read();
   if (c == '\r') { if (read() != '\n') throw protocol(); return text.toString(); }
   if (c == '\n') throw protocol();
   text.append((char) c);
  }
 }

 /** One value starting at {@code c}: a list, a quoted string, a literal, NIL (null) or an atom. */
 private Object value(int c, int depth, String previous) throws IOException {
  if (++values > MAX_VALUES) throw new ImapException(Failure.LIMIT, "IMAP response too large");
  if (c == '(') {
   if (depth >= MAX_DEPTH) throw new ImapException(Failure.LIMIT, "IMAP response nested too deeply");
   List<Object> list = new ArrayList<>();
   String last = null;
   while (true) {
    int next = read();
    if (next == ' ') continue;
    if (next == ')') return list;
    if (next == '\r' || next == '\n') throw protocol();
    Object value = value(next, depth + 1, last);
    list.add(value);
    last = value instanceof String ? (String) value : null;
   }
  }
  if (c == '"') {
   StringBuilder text = new StringBuilder();
   while (true) {
    int next = read();
    if (next == '"') return text.toString();
    if (next == '\\') next = read();
    if (next == '\r' || next == '\n') throw protocol();
    text.append((char) next);
   }
  }
  if (c == '{') return literal(previous);
  if (c == ')' || c == '\r' || c == '\n') throw protocol();
  StringBuilder text = new StringBuilder().append((char) c);
  int brackets = c == '[' ? 1 : 0;
  while (true) {
   int next = peek();
   if (next < 0 || next == '\r' || next == '\n') break;
   if (brackets == 0 && (next == ' ' || next == '(' || next == ')')) break;
   read();
   if (next == '[') brackets++; else if (next == ']' && brackets > 0) brackets--;
   text.append((char) next);
  }
  String atom = text.toString();
  return atom.equalsIgnoreCase("NIL") ? null : atom;
 }

 /** A literal: buffered when small, streamed to the body consumer when it is the requested body part. */
 private Object literal(String previous) throws IOException {
  StringBuilder digits = new StringBuilder();
  while (true) {
   int c = read();
   if (c == '}') break;
   if (c < '0' || c > '9' || digits.length() >= 12) throw protocol();
   digits.append((char) c);
  }
  if (digits.length() == 0 || read() != '\r' || read() != '\n') throw protocol();
  long size = Long.parseLong(digits.toString());
  String item = previous == null ? "" : previous.toUpperCase(Locale.ROOT);
  if (bodyConsumer != null && !bodyDelivered && item.startsWith("BODY[") && !item.contains("HEADER")) {
   if (size > bodyLimit) throw new ImapException(Failure.LIMIT, "Voicemail audio too large");
   bodyDelivered = true;
   Bounded body = new Bounded(size);
   try { bodyConsumer.accept(body); }
   catch (ImapException | SocketTimeoutException failed) { throw failed; }
   catch (IOException | RuntimeException failed) { throw new ImapException(Failure.CONSUMER, "Voicemail audio could not be stored"); }
   body.drain();
   return "";
  }
  if (size > MAX_LITERAL - literalBytes) throw new ImapException(Failure.LIMIT, "IMAP literal too large");
  literalBytes += (int) size;
  ByteArrayOutputStream bytes = new ByteArrayOutputStream((int) size);
  Bounded source = new Bounded(size);
  byte[] buffer = new byte[4096];
  for (int n; (n = source.read(buffer, 0, buffer.length)) > 0; ) bytes.write(buffer, 0, n);
  if (bytes.size() != size) throw protocol();
  return new String(bytes.toByteArray(), StandardCharsets.ISO_8859_1);
 }

 /** Exactly the bytes of one literal; the deadline is checked as they arrive. */
 private final class Bounded extends InputStream {
  private long left;
  Bounded(long size) { left = size; }
  @Override public int read() throws IOException { byte[] one = new byte[1]; return read(one, 0, 1) <= 0 ? -1 : one[0] & 0xff; }
  @Override public int read(byte[] buffer, int offset, int length) throws IOException {
   if (left <= 0) return -1;
   if (length == 0) return 0;
   checkDeadline();
   int n = in.read(buffer, offset, (int) Math.min(length, left));
   if (n < 0) throw new ImapException(Failure.PROTOCOL, "IMAP connection closed");
   left -= n;
   return n;
  }
  void drain() throws IOException { byte[] buffer = new byte[4096]; while (read(buffer, 0, buffer.length) > 0) { /* discard what the consumer left */ } }
 }

 // ---- Helpers -------------------------------------------------------------------------------

 /** A complete answer that makes no sense ends the session like an unreadable one. */
 private ImapException closing(ImapException failure) { close(); return failure; }
 private static ImapException protocol() { return new ImapException(Failure.PROTOCOL, "Unreadable IMAP response"); }
 /** Every failure leaves as an ImapException whose text this class wrote. */
 private static ImapException translate(Throwable failed) {
  if (failed instanceof ImapException) return (ImapException) failed;
  if (failed instanceof SocketTimeoutException) return new ImapException(Failure.TIMEOUT, "IMAP server did not answer in time");
  return new ImapException(Failure.PROTOCOL, "IMAP connection failed");
 }
 /** A quoted string argument. Line breaks and NUL cannot be quoted, so such a value is refused, never sent. */
 static String quoted(String value) {
  if (value == null || value.length() > 512) throw new IllegalArgumentException("Invalid IMAP argument");
  StringBuilder text = new StringBuilder("\"");
  for (int i = 0; i < value.length(); i++) {
   char c = value.charAt(i);
   if (c == '\r' || c == '\n' || c == 0 || c > 0x7e) throw new IllegalArgumentException("Invalid IMAP argument");
   if (c == '"' || c == '\\') text.append('\\');
   text.append(c);
  }
  return text.append('"').toString();
 }
 private static String set(Collection<Long> uids) {
  StringBuilder text = new StringBuilder();
  for (long uid : uids) {
   if (uid <= 0) throw new IllegalArgumentException("Invalid UID");
   if (text.length() > 0) text.append(',');
   text.append(uid);
  }
  return text.toString();
 }
 static long positive(String text) { long value = count(text); return value > 0 ? value : -1; }
 static long count(String text) { return text != null && text.matches("[0-9]{1,18}") ? Long.parseLong(text) : -1; }
}
