package ai.eliza.plugins.messages.vvm;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/** ImapClient against an in-process IMAP server on a loopback socket: the commands, literals, bounds, timeouts and failures. */
public final class ImapClientTest {
 static void require(boolean yes, String what) { if (!yes) throw new AssertionError(what); }
 FakeImapServer server;
 @Before public void start() throws IOException { server = new FakeImapServer(); }
 @After public void stop() throws IOException { server.close(); }

 ImapClient open() throws IOException { return new ImapClient(server.connect(), 2_000, 20_000, null); }
 ImapClient loggedIn() throws IOException { ImapClient imap = open(); imap.login("user", "secret"); imap.select("INBOX"); return imap; }
 interface Attempt { void run() throws IOException; }
 static ImapClient.Failure failure(Attempt attempt) throws IOException {
  try { attempt.run(); } catch (ImapClient.ImapException failed) { return failed.failure; }
  throw new AssertionError("expected an IMAP failure");
 }
 static byte[] bytes(InputStream in) throws IOException {
  ByteArrayOutputStream out = new ByteArrayOutputStream();
  byte[] buffer = new byte[512];
  for (int n; (n = in.read(buffer)) >= 0; ) out.write(buffer, 0, n);
  return out.toByteArray();
 }

 @Test public void readsTheMailbox() throws Exception {
  server.add(4, "\\Seen");
  FakeImapServer.Message second = server.add(9);
  second.textFirst = true; second.duration = 41; second.from = "VOICE=+15555550123";
  ImapClient imap = open();
  imap.login("user", "secret");
  require(imap.capability().equals(new java.util.HashSet<>(Arrays.asList("IMAP4REV1", "UIDPLUS", "QUOTA"))), "capabilities");
  require(imap.select("INBOX") == 7, "UIDVALIDITY from the SELECT answer");
  require(imap.uidSearchAll().equals(Arrays.asList(4L, 9L)), "every UID, ascending");
  List<ImapClient.Fetched> flags = imap.uidFetch(Arrays.asList(4L, 9L), "UID FLAGS");
  require(flags.size() == 2 && flags.get(0).uid() == 4 && flags.get(0).flags().contains("\\seen") && flags.get(1).flags().isEmpty(), "flags");
  List<ImapClient.Fetched> full = imap.uidFetch(Collections.singletonList(9L), "UID FLAGS INTERNALDATE ENVELOPE BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (CONTENT-DURATION)]");
  require(full.size() == 1 && full.get(0).uid() == 9, "one message");
  require(VvmSync.sender(full.get(0).items.get("ENVELOPE")).equals("+15555550123"), "the caller from the envelope, VOICE= removed");
  require(VvmSync.date(full.get(0)) == 1784256265000L, "the envelope date");
  require(VvmSync.duration(full.get(0)) == 41, "Content-Duration from a header literal inside the response");
  VvmSync.Part part = VvmSync.audioPart(full.get(0).items.get("BODYSTRUCTURE"));
  require(part != null && part.section.equals("2") && part.mimeType.equals("audio/amr") && part.encoding.equals("base64") && part.size == second.encoded().length(), "the audio part and its section");
  byte[][] audio = new byte[1][];
  require(imap.fetchBody(9, part.section, 1 << 20, body -> audio[0] = bytes(Base64.getMimeDecoder().wrap(body))), "body delivered");
  require(Arrays.equals(audio[0], second.audio), "the literal's bytes, decoded");
  require(!server.message(9).flags.contains("\\Seen"), "reading audio does not mark the message heard");
  require(!imap.fetchBody(9, "5", 1 << 20, body -> { throw new AssertionError("no such part"); }), "an absent part is not delivered");
  require(Arrays.equals(imap.quota("INBOX"), new long[] { 10, 512 }), "storage quota");
  require(imap.uidFetch(Collections.<Long>emptyList(), "UID FLAGS").isEmpty(), "nothing asked, nothing sent");
  imap.logout();
  require(server.commands().get(server.commands().size() - 1).equals("LOGOUT"), "said goodbye");
  require(failure(() -> imap.uidSearchAll()) == ImapClient.Failure.PROTOCOL, "a closed session answers nothing");
 }

 @Test public void aRefusedLoginIsAnAuthenticationFailure() throws Exception {
  ImapClient imap = open();
  require(failure(() -> imap.login("user", "wrong")) == ImapClient.Failure.AUTHENTICATION, "NO to LOGIN");
  try { imap.login("user", "wrong"); } catch (ImapClient.ImapException failed) { require(!failed.getMessage().contains("wrong") && !failed.getMessage().contains("invalid credentials"), "no credential or server text in the failure"); }
  imap.close();
 }

 @Test public void credentialsThatCannotBeQuotedAreNeverSent() throws Exception {
  ImapClient imap = open();
  for (String bad : new String[] { "p\r\na2 LOGOUT", "p\nx", "p\u0000", "café", null })
   try { imap.login("user", bad); throw new AssertionError("sent"); } catch (IllegalArgumentException expected) { /* refused before the wire */ }
  require(!server.sent("LOGIN"), "nothing reached the server");
  server.password = "a\"b\\c";
  imap.login("user", "a\"b\\c");
  imap.close();
 }

 @Test public void flagsAreStoredAndDeletedMessagesExpunged() throws Exception {
  server.add(1); server.add(2); server.add(3, "\\Deleted");
  ImapClient imap = loggedIn();
  imap.addFlag(Arrays.asList(1L, 2L), "\\Seen");
  require(server.message(1).flags.contains("\\Seen") && server.message(2).flags.contains("\\Seen"), "seen stored");
  imap.addFlag(Collections.singletonList(2L), "\\Deleted");
  imap.expunge(Collections.singletonList(2L), true);
  require(server.message(2) == null && server.message(3) != null && server.sent("UID EXPUNGE 2"), "with UIDPLUS only the named message is expunged");
  imap.expunge(Collections.singletonList(3L), false);
  require(server.message(3) == null && server.message(1) != null, "plain EXPUNGE removes what is flagged");
  try { imap.addFlag(Collections.singletonList(1L), "\\Seen) x"); throw new AssertionError("flag injection"); } catch (IllegalArgumentException expected) { /* refused */ }
  try { imap.addFlag(Collections.singletonList(0L), "\\Seen"); throw new AssertionError("UID 0"); } catch (IllegalArgumentException expected) { /* refused */ }
  imap.logout();
 }

 @Test public void anOversizeBodyLiteralIsRefusedBeforeAnyOfItIsRead() throws Exception {
  server.add(1);
  ImapClient imap = loggedIn();
  server.overrides.put("UID FETCH", "* 1 FETCH (UID 1 BODY[1] {99999999}\r\nAAAA");
  AtomicBoolean delivered = new AtomicBoolean();
  require(failure(() -> imap.fetchBody(1, "1", 1024, body -> delivered.set(true))) == ImapClient.Failure.LIMIT, "over the caller's limit");
  require(!delivered.get(), "the consumer saw nothing");
  require(failure(() -> imap.uidSearchAll()) == ImapClient.Failure.PROTOCOL, "the session is closed, not resynchronised");
 }

 @Test public void aBodyWithinTheLimitIsDeliveredWhole() throws Exception {
  FakeImapServer.Message message = server.add(1);
  message.audio = new byte[200_000];
  new java.util.Random(7).nextBytes(message.audio);
  ImapClient imap = loggedIn();
  byte[][] audio = new byte[1][];
  require(imap.fetchBody(1, "1", message.encoded().length(), body -> audio[0] = bytes(Base64.getMimeDecoder().wrap(body))), "exactly at the limit");
  require(Arrays.equals(audio[0], message.audio), "200 kB intact, larger than any buffered literal");
  require(failure(() -> imap.fetchBody(1, "1", message.encoded().length() - 1, body -> { })) == ImapClient.Failure.LIMIT, "one byte over");
 }

 @Test public void aConsumerThatReadsNothingLeavesTheSessionInStep() throws Exception {
  server.add(1); server.add(2);
  ImapClient imap = loggedIn();
  require(imap.fetchBody(1, "1", 1 << 20, body -> { }), "delivered, unread");
  require(imap.uidSearchAll().size() == 2, "the rest of the literal was skipped");
  require(failure(() -> imap.fetchBody(1, "1", 1 << 20, body -> { throw new IOException("disk full at /data/secret"); })) == ImapClient.Failure.CONSUMER, "a storing failure is its own kind");
 }

 @Test public void oversizeResponsesAreRefused() throws Exception {
  server.add(1);
  ImapClient literal = loggedIn();
  server.overrides.put("UID FETCH", "* 1 FETCH (UID 1 ENVELOPE {70000}\r\n");
  require(failure(() -> literal.uidFetch(Collections.singletonList(1L), "UID ENVELOPE")) == ImapClient.Failure.LIMIT, "a buffered literal over 64 KiB");

  StringBuilder line = new StringBuilder("* SEARCH");
  while (line.length() < 20_000) line.append(" 1");
  server.overrides.clear();
  ImapClient longLine = loggedIn();
  server.overrides.put("UID SEARCH", line + "\r\n%t OK done\r\n");
  require(failure(longLine::uidSearchAll) == ImapClient.Failure.LIMIT, "a response line over 16 KiB");

  StringBuilder uids = new StringBuilder();
  for (int burst = 0; burst < 3; burst++) { uids.append("* SEARCH"); for (int i = 1; i <= 800; i++) uids.append(' ').append(burst * 800 + i); uids.append("\r\n"); }
  server.overrides.clear();
  ImapClient many = loggedIn();
  server.overrides.put("UID SEARCH", uids + "%t OK done\r\n");
  require(failure(many::uidSearchAll) == ImapClient.Failure.LIMIT, "more messages than one sync will handle");

  StringBuilder nested = new StringBuilder("* 1 FETCH ");
  for (int i = 0; i < 40; i++) nested.append('(');
  server.overrides.clear();
  ImapClient deep = loggedIn();
  server.overrides.put("UID FETCH", nested + "\r\n");
  require(failure(() -> deep.uidFetch(Collections.singletonList(1L), "UID BODYSTRUCTURE")) == ImapClient.Failure.LIMIT, "nesting deeper than any body structure");
 }

 @Test public void aSilentServerTimesOut() throws Exception {
  server.overrides.put("UID SEARCH", FakeImapServer.STALL);
  ImapClient imap = new ImapClient(server.connect(), 300, 20_000, null);
  imap.login("user", "secret"); imap.select("INBOX");
  long started = System.nanoTime();
  require(failure(imap::uidSearchAll) == ImapClient.Failure.TIMEOUT, "no answer within the read timeout");
  require(System.nanoTime() - started < 5_000_000_000L, "and promptly");
  require(failure(imap::uidSearchAll) == ImapClient.Failure.PROTOCOL, "the session is closed");
 }

 @Test public void theWholeSessionHasADeadline() throws Exception {
  server.add(1);
  server.overrides.put("UID FETCH", "* 1 FETCH (UID 1 BODY[1] {5000}\r\nAAAA");
  ImapClient imap = new ImapClient(server.connect(), 5_000, 400, null);
  imap.login("user", "secret"); imap.select("INBOX");
  Thread.sleep(450);
  require(failure(() -> imap.fetchBody(1, "1", 1 << 20, body -> bytes(body))) == ImapClient.Failure.TIMEOUT, "the whole session has a deadline");
 }

 @Test public void unreadableAnswersCloseTheSession() throws Exception {
  for (String garbage : new String[] { "nonsense\r\n", "* SEARCH (1 2\r\n%t OK\r\n", "* SEARCH one\r\n%t OK\r\n", "%t MAYBE\r\n", "+ go on\r\n", "* SEARCH {x}\r\n", "* SEARCH \"open\r\n" }) {
   server.overrides.clear();
   ImapClient imap = loggedIn();
   server.overrides.put("UID SEARCH", garbage);
   require(failure(imap::uidSearchAll) == ImapClient.Failure.PROTOCOL, "refused: " + garbage.trim());
   require(failure(() -> imap.capability()) == ImapClient.Failure.PROTOCOL, "closed after: " + garbage.trim());
  }
 }

 @Test public void aRefusingGreetingOrADroppedConnectionFails() throws Exception {
  server.greeting = "* BYE overloaded";
  require(failure(this::open) == ImapClient.Failure.REFUSED, "BYE greeting");
  server.greeting = "* OK ready";
  ImapClient imap = loggedIn();
  server.close();
  require(failure(imap::uidSearchAll) == ImapClient.Failure.PROTOCOL, "connection dropped");
 }

 @Test public void aRefusedCommandKeepsTheSessionAndTheReleaseRunsOnce() throws Exception {
  server.quota = false;
  int[] released = { 0 };
  ImapClient imap = new ImapClient(server.connect(), 2_000, 20_000, () -> released[0]++);
  imap.login("user", "secret");
  Set<String> capabilities = imap.capability();
  require(!capabilities.contains("QUOTA"), "not advertised");
  server.overrides.put("GETQUOTAROOT", "%t NO no quota here\r\n");
  require(failure(() -> imap.quota("INBOX")) == ImapClient.Failure.REFUSED, "NO is a refusal");
  require(imap.select("INBOX") == 7, "and the session goes on");
  imap.logout(); imap.close();
  require(released[0] == 1, "the network is given back exactly once");
 }
}
