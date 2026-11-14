package ai.eliza.plugins.messages.vvm;

import java.io.BufferedReader;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * An in-process IMAP server over a loopback socket holding one voicemail INBOX. It speaks just the
 * commands the client sends, and can be told to answer a command with raw text or not at all.
 */
final class FakeImapServer implements Closeable {
 static final class Message {
  final long uid; final Set<String> flags = new HashSet<>();
  String from = "+15555550100", date = "Fri, 17 Jul 2026 02:44:25 +0000", subtype = "amr";
  int duration = 17; byte[] audio = "#!AMR\nvoice".getBytes(StandardCharsets.ISO_8859_1);
  /** False for a message with no audio part (a fax or a delivery notice). */
  boolean voice = true;
  /** Puts a text part before the audio, so the audio is body section 2. */
  boolean textFirst;
  Message(long uid) { this.uid = uid; }
  String encoded() { return Base64.getMimeEncoder().encodeToString(audio); }
 }

 final List<Message> messages = new ArrayList<>();
 final List<String> commands = new ArrayList<>();
 /** Command prefix → raw reply ("%t" is the tag), or {@link #STALL} to never answer. */
 final Map<String, String> overrides = new LinkedHashMap<>();
 static final String STALL = "\u0000stall";
 String user = "user", password = "secret", greeting = "* OK ready";
 long uidValidity = 7;
 boolean uidPlus = true, quota = true;
 volatile int sessions;

 private final ServerSocket server;
 private final List<Socket> open = new ArrayList<>();
 private volatile boolean closed;

 FakeImapServer() throws IOException {
  server = new ServerSocket(0, 8, InetAddress.getLoopbackAddress());
  Thread thread = new Thread(() -> {
   while (!closed) {
    try {
     Socket socket = server.accept();
     synchronized (open) { open.add(socket); }
     sessions++;
     Thread session = new Thread(() -> serve(socket), "fake-imap-session");
     session.setDaemon(true); session.start();
    } catch (IOException stopped) { return; }
   }
  }, "fake-imap");
  thread.setDaemon(true); thread.start();
 }
 int port() { return server.getLocalPort(); }
 Socket connect() throws IOException { return new Socket(InetAddress.getLoopbackAddress(), port()); }
 synchronized Message add(long uid, String... flags) { Message message = new Message(uid); for (String flag : flags) message.flags.add(flag); messages.add(message); return message; }
 synchronized Message message(long uid) { for (Message message : messages) if (message.uid == uid) return message; return null; }
 synchronized List<String> commands() { return new ArrayList<>(commands); }
 synchronized boolean sent(String prefix) { for (String command : commands) if (command.startsWith(prefix)) return true; return false; }

 @Override public void close() throws IOException {
  closed = true;
  server.close();
  synchronized (open) { for (Socket socket : open) socket.close(); }
 }

 private void serve(Socket socket) {
  try (Socket s = socket) {
   BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.ISO_8859_1));
   OutputStream out = s.getOutputStream();
   write(out, greeting + "\r\n");
   for (String line; (line = in.readLine()) != null; ) {
    int space = line.indexOf(' ');
    if (space < 0) { write(out, "* BAD\r\n"); continue; }
    String tag = line.substring(0, space), command = line.substring(space + 1);
    String reply;
    synchronized (this) { commands.add(command); reply = reply(tag, command); }
    if (reply == null) { Thread.sleep(60_000); return; }
    write(out, reply);
    if (command.equals("LOGOUT")) return;
   }
  } catch (IOException | InterruptedException ended) { /* the test closed the session */ }
 }
 private static void write(OutputStream out, String text) throws IOException { out.write(text.getBytes(StandardCharsets.ISO_8859_1)); out.flush(); }

 private String reply(String tag, String command) {
  for (Map.Entry<String, String> override : overrides.entrySet())
   if (command.startsWith(override.getKey())) return STALL.equals(override.getValue()) ? null : override.getValue().replace("%t", tag);
  String ok = tag + " OK done\r\n";
  if (command.equals("CAPABILITY")) return "* CAPABILITY IMAP4rev1" + (uidPlus ? " UIDPLUS" : "") + (quota ? " QUOTA" : "") + "\r\n" + ok;
  if (command.startsWith("LOGIN ")) return command.equals("LOGIN " + ImapClient.quoted(user) + " " + ImapClient.quoted(password)) ? ok : tag + " NO [AUTHENTICATIONFAILED] invalid credentials\r\n";
  if (command.startsWith("SELECT ")) return "* " + messages.size() + " EXISTS\r\n* FLAGS (\\Seen \\Deleted)\r\n* OK [UIDVALIDITY " + uidValidity + "] UIDs valid\r\n" + tag + " OK [READ-WRITE] selected\r\n";
  if (command.equals("UID SEARCH ALL")) {
   StringBuilder found = new StringBuilder("* SEARCH");
   for (Message message : messages) found.append(' ').append(message.uid);
   return found + "\r\n" + ok;
  }
  Matcher fetch = Pattern.compile("UID FETCH ([0-9,]+) \\((.*)\\)").matcher(command);
  if (fetch.matches()) {
   StringBuilder all = new StringBuilder();
   int sequence = 0;
   for (Message message : messages) {
    sequence++;
    if (!uids(fetch.group(1)).contains(message.uid)) continue;
    all.append("* ").append(sequence).append(" FETCH (").append(items(message, fetch.group(2))).append(")\r\n");
   }
   return all + ok;
  }
  Matcher store = Pattern.compile("UID STORE ([0-9,]+) \\+FLAGS\\.SILENT \\((\\\\[A-Za-z]+)\\)").matcher(command);
  if (store.matches()) {
   for (Message message : messages) if (uids(store.group(1)).contains(message.uid)) message.flags.add(store.group(2));
   return ok;
  }
  if (command.equals("EXPUNGE")) { messages.removeIf(message -> message.flags.contains("\\Deleted")); return ok; }
  if (command.startsWith("UID EXPUNGE ")) {
   if (!uidPlus) return tag + " BAD unknown command\r\n";
   Set<Long> named = uids(command.substring(12));
   messages.removeIf(message -> named.contains(message.uid) && message.flags.contains("\\Deleted"));
   return ok;
  }
  if (command.startsWith("GETQUOTAROOT ")) return quota ? "* QUOTAROOT \"INBOX\" \"\"\r\n* QUOTA \"\" (STORAGE 10 512)\r\n" + ok : tag + " BAD unknown command\r\n";
  if (command.equals("LOGOUT")) return "* BYE bye\r\n" + ok;
  return tag + " BAD unknown command\r\n";
 }

 private static Set<Long> uids(String set) { Set<Long> uids = new HashSet<>(); for (String uid : set.split(",")) uids.add(Long.parseLong(uid)); return uids; }

 private static String items(Message message, String wanted) {
  String upper = wanted.toUpperCase(Locale.ROOT);
  StringBuilder text = new StringBuilder("UID ").append(message.uid);
  if (upper.contains("FLAGS")) text.append(" FLAGS (").append(String.join(" ", message.flags)).append(")");
  if (upper.contains("INTERNALDATE")) text.append(" INTERNALDATE \"17-Jul-2026 02:44:30 +0000\"");
  if (upper.contains("ENVELOPE")) text.append(" ENVELOPE (\"").append(message.date).append("\" \"Voice message\" ((NIL NIL \"").append(message.from)
    .append("\" \"vm.carrier.example\")) NIL NIL ((NIL NIL \"me\" \"vm.carrier.example\")) NIL NIL NIL \"<m").append(message.uid).append("@vm>\")");
  if (upper.contains("BODYSTRUCTURE")) {
   String note = "(\"text\" \"plain\" (\"charset\" \"us-ascii\") NIL NIL \"7bit\" 12 1)";
   String audio = "(\"AUDIO\" \"" + message.subtype + "\" (\"name\" \"v (1).amr\") NIL NIL \"BASE64\" " + message.encoded().length() + " NIL (\"attachment\" NIL) NIL)";
   text.append(" BODYSTRUCTURE ").append(!message.voice ? note : message.textFirst ? "(" + note + audio + " \"voice-message\")" : "(" + audio + note + " \"voice-message\")");
  }
  if (upper.contains("HEADER.FIELDS")) {
   String header = "Content-Duration: " + message.duration + "\r\n\r\n";
   text.append(" BODY[HEADER.FIELDS (CONTENT-DURATION)] {").append(header.length()).append("}\r\n").append(header);
  }
  Matcher body = Pattern.compile("BODY\\.PEEK\\[([0-9.]+)\\]").matcher(upper);
  if (body.find()) {
   String section = message.textFirst ? "2" : "1";
   if (message.voice && body.group(1).equals(section)) text.append(" BODY[").append(section).append("] {").append(message.encoded().length()).append("}\r\n").append(message.encoded());
   else text.append(" BODY[").append(body.group(1)).append("] NIL");
  }
  return text.toString();
 }
}
