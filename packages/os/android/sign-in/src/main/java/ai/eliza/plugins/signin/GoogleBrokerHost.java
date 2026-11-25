// spec/os/signIn/cloudRequests.md, "Story: Let my agent read my mail without holding a mail credential"; spec/os/signIn/cloudRequests.md, "The agent reaches the broker only by a bodiless GET on the loopback host, without an origin, with the current launch's bearer"; spec/os/signIn/cloudRequests.md, "The broker forwards only the owner's Gmail account list and search, with the lease, while the launch's owner holds it"; spec/os/signIn/cloudRequests.md, "The agent gets the cloud's status and body, or a refusal naming why nothing was read, and never the credential that read it"
package ai.eliza.plugins.signin;

import ai.eliza.os.agent.AgentCredentials;
import ai.eliza.os.agent.GoogleBroker;
import ai.eliza.plugins.signin.CloudRequestPolicy.Refusal;
import ai.eliza.plugins.signin.CredentialPolicy.Account;
import ai.eliza.plugins.signin.GoogleBrokerPolicy.Answer;
import ai.eliza.plugins.signin.GoogleBrokerPolicy.Ask;
import ai.eliza.plugins.signin.GoogleBrokerPolicy.AskVerdict;
import ai.eliza.plugins.signin.GoogleBrokerPolicy.Call;
import ai.eliza.plugins.signin.GoogleBrokerPolicy.CallRefused;
import ai.eliza.plugins.signin.GoogleBrokerPolicy.Outcome;
import ai.eliza.plugins.signin.GoogleBrokerPolicy.Refused;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.function.Supplier;

public final class GoogleBrokerHost implements GoogleBroker, AutoCloseable {
  public interface MailReads {
    CloudRequests.MailAuthority authority();
    CloudRequests.Outcome read(CloudRequests.MailAuthority expected, String target);
  }

  private record Launch(Endpoint endpoint, Account owner) {}

  private record Exchange(int status, byte[] body) {}

  private static final int WORKERS = 4, BACKLOG = 8, SOCKET_TIMEOUT_MS = 35_000, HEAD_LIMIT = 8192, DRAIN_LIMIT = 65_536;
  private static final byte[] LOOPBACK = {127, 0, 0, 1};
  private static final SecureRandom RANDOM = new SecureRandom();

  private final MailReads reads;
  private final ExecutorService workers = Executors.newFixedThreadPool(WORKERS, task -> {
    Thread thread = new Thread(task, "ElizaOwnerGmailBroker");
    thread.setDaemon(true);
    return thread;
  });
  private ServerSocket server;
  private volatile Launch launch;

  public GoogleBrokerHost(MailReads reads) { this.reads = reads; }

  public static GoogleBrokerHost overDevice(String apiOrigin, Supplier<CloudRequests.Custody> custody, File cacheDirectory) {
    CloudRequests requests = new CloudRequests(CloudRequestPolicy.forMailReads(GoogleBrokerPolicy::queriesFor), new LargeBodyGrant(cacheDirectory));
    return new GoogleBrokerHost(new MailReads() {
      @Override public CloudRequests.MailAuthority authority() { return custody.get().mailAuthority(); }
      @Override public CloudRequests.Outcome read(CloudRequests.MailAuthority expected, String target) {
        return requests.readMail(apiOrigin, custody.get(), expected, target, Map.of(CloudRequestPolicy.ACCEPT, "application/json"));
      }
    });
  }

  @Override public synchronized Endpoint open(AgentCredentials.Account owner) throws IOException {
    if (server == null || server.isClosed()) {
      ServerSocket bound = new ServerSocket(0, BACKLOG, InetAddress.getByAddress(LOOPBACK));
      server = bound;
      Thread accepting = new Thread(() -> accept(bound), "ElizaOwnerGmailBrokerAccept");
      accepting.setDaemon(true);
      accepting.start();
    }
    byte[] secret = new byte[48];
    RANDOM.nextBytes(secret);
    Endpoint opened = new Endpoint(server.getLocalPort(), Base64.getUrlEncoder().withoutPadding().encodeToString(secret));
    launch = new Launch(opened, new Account(owner.userId(), owner.organizationId()));
    return opened;
  }

  @Override public synchronized void close() throws IOException {
    launch = null;
    if (server != null) server.close();
    server = null;
  }

  private void accept(ServerSocket bound) {
    while (!bound.isClosed()) {
      Socket socket;
      try { socket = bound.accept(); }
      catch (IOException closed) { return; }
      try { workers.execute(() -> answer(socket)); }
      catch (RejectedExecutionException busy) { quietly(socket); }
    }
  }

  private void answer(Socket socket) {
    try (socket) {
      socket.setSoTimeout(SOCKET_TIMEOUT_MS);
      InputStream in = socket.getInputStream();
      Exchange reply = exchange(in, launch);
      OutputStream out = socket.getOutputStream();
      out.write(("HTTP/1.1 " + reply.status() + " " + (reply.status() < 300 ? "OK" : "Refused") + "\r\nContent-Type: application/json\r\n"
        + "Cache-Control: no-store\r\nContent-Length: " + reply.body().length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
      out.write(reply.body());
      out.flush();
      socket.shutdownOutput();
      drain(in);
    } catch (IOException | RuntimeException dropped) {
      quietly(socket);
    }
  }

  private Exchange exchange(InputStream in, Launch current) throws IOException {
    String head = head(in);
    String[] start = head == null ? new String[0] : head.split("\r\n", -1)[0].split(" ", -1);
    Map<String, String> headers = head == null || start.length != 3 || !start[2].startsWith("HTTP/1.") ? null : headers(head);
    boolean parsed = headers != null && current != null;
    Ask ask = new Ask(parsed && "GET".equals(start[0]),
      parsed && !headers.containsKey("transfer-encoding") && "0".equals(headers.getOrDefault("content-length", "0")),
      parsed && ("127.0.0.1:" + current.endpoint().port()).equals(headers.get("host")),
      !parsed || headers.containsKey("origin"),
      parsed && MessageDigest.isEqual(("Bearer " + current.endpoint().bearer()).getBytes(StandardCharsets.UTF_8),
        headers.getOrDefault("authorization", "").getBytes(StandardCharsets.UTF_8)));
    AskVerdict verdict = GoogleBrokerPolicy.askVerdict(ask);
    if (verdict == AskVerdict.NOT_PRIVATE) return refusal(403, "not-private");
    if (verdict == AskVerdict.NOT_AUTHORIZED) return refusal(401, "not-authorized");
    String target = start[1].startsWith(GoogleBroker.PATH + "/") ? start[1].substring(GoogleBroker.PATH.length()) : "";
    int query = target.indexOf('?');
    String path = query < 0 ? target : target.substring(0, query);
    List<String> fields = new ArrayList<>();
    if (query >= 0)
      for (String pair : target.substring(query + 1).split("&", -1)) fields.add(pair.contains("=") ? pair.substring(0, pair.indexOf('=')) : pair);
    CloudRequests.MailAuthority authority = reads.authority();
    Call call = new Call(GoogleBrokerPolicy.readOf(path), fields, authority != null && authority.account().equals(current.owner()));
    Refusal refused = GoogleBrokerPolicy.refusalOf(call);
    if (refused != null) return replied(new CallRefused(refused), null);
    CloudRequests.Outcome sent = reads.read(authority, target);
    return replied(GoogleBrokerPolicy.outcomeOf(sent), sent instanceof CloudRequests.Answered answered ? answered.body() : null);
  }

  private static Map<String, String> headers(String head) {
    Map<String, String> headers = new HashMap<>();
    String[] lines = head.split("\r\n", -1);
    for (int at = 1; at < lines.length; at++) {
      int colon = lines[at].indexOf(':');
      if (colon <= 0 || headers.put(lines[at].substring(0, colon).trim().toLowerCase(Locale.ROOT), lines[at].substring(colon + 1).trim()) != null)
        return null;
    }
    return headers;
  }

  private static Exchange replied(Outcome outcome, byte[] body) {
    return switch (GoogleBrokerPolicy.replyOf(outcome)) {
      case Answer answer -> new Exchange(answer.status(), body);
      case Refused refused -> refusal(refused.status(), refused.reason().wire);
    };
  }

  private static Exchange refusal(int status, String reason) {
    return new Exchange(status, ("{\"reason\":" + CredentialJson.quote(reason) + "}").getBytes(StandardCharsets.UTF_8));
  }

  private static String head(InputStream in) throws IOException {
    ByteArrayOutputStream read = new ByteArrayOutputStream();
    int matched = 0;
    while (read.size() < HEAD_LIMIT) {
      int next = in.read();
      if (next < 0) return null;
      read.write(next);
      matched = next == (matched % 2 == 0 ? '\r' : '\n') ? matched + 1 : next == '\r' ? 1 : 0;
      if (matched == 4) {
        String text = read.toString(StandardCharsets.ISO_8859_1);
        return text.substring(0, text.length() - 4);
      }
    }
    return null;
  }

  private static void drain(InputStream in) throws IOException {
    byte[] unread = new byte[HEAD_LIMIT];
    for (long drained = 0; drained < DRAIN_LIMIT; ) {
      int count = in.read(unread);
      if (count < 0) return;
      drained += count;
    }
  }

  private static void quietly(Socket socket) {
    try { socket.close(); }
    catch (IOException ignored) { }
  }
}
