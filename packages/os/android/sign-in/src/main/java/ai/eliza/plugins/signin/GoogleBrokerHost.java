// spec/os/signIn/cloudRequests.md, "Story: Let my agent read my mail without holding a mail credential"; spec/os/signIn/cloudRequests.md, "The agent reaches the broker only by a bodiless GET on the loopback host, without an origin, with the current launch's bearer"; spec/os/signIn/cloudRequests.md, "The broker forwards only the owner's Gmail account list and search, with the lease, while the launch's owner holds it"; spec/os/signIn/cloudRequests.md, "The agent gets the cloud's status and body, or a refusal naming why nothing was read, and never the credential that read it"
package ai.eliza.plugins.signin;

import ai.eliza.os.agent.AgentCredentials;
import ai.eliza.os.agent.GoogleBroker;
import ai.eliza.plugins.signin.CloudRequestPolicy.CallPlan;
import ai.eliza.plugins.signin.CloudRequestPolicy.Holding;
import ai.eliza.plugins.signin.CloudRequestPolicy.RefreshLeaseFirst;
import ai.eliza.plugins.signin.CloudRequestPolicy.Refuse;
import ai.eliza.plugins.signin.CloudRequestPolicy.Send;
import ai.eliza.plugins.signin.CloudRequestPolicy.WithLease;
import ai.eliza.plugins.signin.CredentialPolicy.Account;
import ai.eliza.plugins.signin.GoogleBrokerPolicy.Answer;
import ai.eliza.plugins.signin.GoogleBrokerPolicy.Ask;
import ai.eliza.plugins.signin.GoogleBrokerPolicy.AskVerdict;
import ai.eliza.plugins.signin.GoogleBrokerPolicy.Call;
import ai.eliza.plugins.signin.GoogleBrokerPolicy.CallRefused;
import ai.eliza.plugins.signin.GoogleBrokerPolicy.CloudUnreachable;
import ai.eliza.plugins.signin.GoogleBrokerPolicy.Outcome;
import ai.eliza.plugins.signin.GoogleBrokerPolicy.Read;
import ai.eliza.plugins.signin.GoogleBrokerPolicy.Refused;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
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
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.function.Supplier;

public final class GoogleBrokerHost implements GoogleBroker {
  public record Standing(Account signedIn, int key, CloudRequests.MailAuthority authority) {}

  public interface MailReads {
    Standing standing();
    CloudRequests.Outcome read(CloudRequests.MailAuthority expected, String target);
  }

  private record Launch(Endpoint endpoint, Account owner) {}

  private record Exchange(int status, byte[] body) {}

  private record Listening(ServerSocket server, ExecutorService workers, Semaphore admitted) {}

  private static final int WORKERS = 4, WAITING = 4, BACKLOG = 8, DEADLINE_MS = 5_000, ACCEPT_RETRY_MS = 250, HEAD_LIMIT = 8192, DRAIN_LIMIT = 65_536;
  private static final byte[] LOOPBACK = {127, 0, 0, 1};
  private static final SecureRandom RANDOM = new SecureRandom();

  private final MailReads reads;
  private final Consumer<RuntimeException> failed;
  private Listening listening;
  private volatile Launch launch;

  public GoogleBrokerHost(MailReads reads, Consumer<RuntimeException> failed) {
    this.reads = reads;
    this.failed = failed;
  }

  public static GoogleBrokerHost overDevice(String apiOrigin, Supplier<CloudRequests.Custody> custody, File cacheDirectory, Consumer<RuntimeException> failed) {
    CloudRequests requests = new CloudRequests(CloudRequestPolicy.forMailReads(GoogleBrokerPolicy::queriesFor), new LargeBodyGrant(cacheDirectory));
    return new GoogleBrokerHost(new MailReads() {
      @Override public Standing standing() {
        CredentialPolicy.State state = custody.get().credentials().state();
        return new Standing(CredentialPolicy.isSignedIn(state) ? CredentialPolicy.accountOf(state) : null, CredentialPolicy.activeVersion(state),
          CloudRequests.authorityOf(state));
      }
      @Override public CloudRequests.Outcome read(CloudRequests.MailAuthority expected, String target) {
        return requests.readMail(apiOrigin, custody.get(), expected, target, Map.of(CloudRequestPolicy.ACCEPT, "application/json"));
      }
    }, failed);
  }

  @Override public synchronized Endpoint open(AgentCredentials.Account owner) throws IOException {
    if (listening == null) {
      ServerSocket bound = new ServerSocket(0, BACKLOG, InetAddress.getByAddress(LOOPBACK));
      listening = new Listening(bound, Executors.newFixedThreadPool(WORKERS, task -> {
        Thread thread = new Thread(task, "ElizaOwnerGmailBroker");
        thread.setDaemon(true);
        return thread;
      }), new Semaphore(WORKERS + WAITING));
      Listening serving = listening;
      Thread accepting = new Thread(() -> accept(serving), "ElizaOwnerGmailBrokerAccept");
      accepting.setDaemon(true);
      accepting.start();
    }
    byte[] secret = new byte[48];
    RANDOM.nextBytes(secret);
    Endpoint opened = new Endpoint(listening.server().getLocalPort(), Base64.getUrlEncoder().withoutPadding().encodeToString(secret));
    launch = new Launch(opened, new Account(owner.userId(), owner.organizationId()));
    return opened;
  }

  @Override public synchronized void revoke(Endpoint launched) {
    if (launch != null && launch.endpoint().equals(launched)) launch = null;
  }

  @Override public synchronized void revoke() { launch = null; }

  @Override public synchronized void close() throws IOException {
    launch = null;
    if (listening == null) return;
    Listening closing = listening;
    listening = null;
    closing.workers().shutdownNow();
    closing.server().close();
  }

  private void accept(Listening serving) {
    boolean failing = false;
    while (!serving.server().isClosed()) {
      Socket socket;
      try { socket = serving.server().accept(); }
      catch (IOException refused) {
        if (serving.server().isClosed()) return;
        if (!failing) failed.accept(new UncheckedIOException("The mail broker could not accept a connection", refused));
        failing = true;
        try { Thread.sleep(ACCEPT_RETRY_MS); }
        catch (InterruptedException stopped) {
          Thread.currentThread().interrupt();
          return;
        }
        continue;
      }
      failing = false;
      if (!serving.admitted().tryAcquire()) {
        quietly(socket);
        continue;
      }
      try {
        serving.workers().execute(() -> {
          try { answer(socket); }
          finally { serving.admitted().release(); }
        });
      } catch (RejectedExecutionException closed) {
        serving.admitted().release();
        quietly(socket);
      }
    }
  }

  private void answer(Socket socket) {
    try (socket) {
      InputStream in = socket.getInputStream();
      Exchange reply = exchange(head(socket, in, deadline()), socket.getLocalPort());
      OutputStream out = socket.getOutputStream();
      out.write(("HTTP/1.1 " + reply.status() + " " + (reply.status() < 300 ? "OK" : "Refused") + "\r\nContent-Type: application/json\r\n"
        + "Cache-Control: no-store\r\nContent-Length: " + reply.body().length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
      out.write(reply.body());
      out.flush();
      socket.shutdownOutput();
      drain(socket, in, deadline());
    } catch (IOException dropped) {
      quietly(socket);
    } catch (RuntimeException unexpected) {
      quietly(socket);
      failed.accept(unexpected);
    }
  }

  private Exchange exchange(String head, int port) {
    Launch current = launch;
    String[] start = head == null ? new String[0] : head.split("\r\n", -1)[0].split(" ", -1);
    Map<String, String> headers = head == null || start.length != 3 || !start[2].startsWith("HTTP/1.") ? null : headers(head);
    boolean parsed = headers != null;
    Ask ask = new Ask(parsed && "GET".equals(start[0]),
      parsed && !headers.containsKey("transfer-encoding") && "0".equals(headers.getOrDefault("content-length", "0")),
      parsed && ("127.0.0.1:" + port).equals(headers.get("host")),
      !parsed || headers.containsKey("origin"),
      parsed && current != null && MessageDigest.isEqual(("Bearer " + current.endpoint().bearer()).getBytes(StandardCharsets.UTF_8),
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
    try {
      return forwarded(current.owner(), GoogleBrokerPolicy.readOf(path), fields, target);
    } catch (RuntimeException unplanned) {
      failed.accept(unplanned);
      return replied(new CloudUnreachable(), null);
    }
  }

  private Exchange forwarded(Account owner, Read read, List<String> fields, String target) {
    Standing now = reads.standing();
    CloudRequests.MailAuthority authority = now.authority();
    boolean ownerHolds = owner.equals(now.signedIn()) && (authority == null || owner.equals(authority.account()));
    CallPlan plan = GoogleBrokerPolicy.brokerPlan(new Holding(now.key(), false, false, authority != null, false), new Call(read, fields, ownerHolds));
    switch (plan) {
      case Refuse refuse -> { return replied(new CallRefused(refuse.why()), null); }
      case RefreshLeaseFirst lease -> { }
      case Send send when send.attach() instanceof WithLease -> { }
      default -> throw new IllegalStateException("The mail broker planned a read without the lease");
    }
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

  private static long deadline() { return System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(DEADLINE_MS); }

  private static void waitUntil(Socket socket, long deadline) throws IOException {
    long left = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime());
    if (left < 1) throw new SocketTimeoutException("The broker's request deadline passed");
    socket.setSoTimeout(Math.toIntExact(left));
  }

  private static String head(Socket socket, InputStream in, long deadline) throws IOException {
    ByteArrayOutputStream read = new ByteArrayOutputStream();
    int matched = 0;
    while (read.size() < HEAD_LIMIT) {
      waitUntil(socket, deadline);
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

  private static void drain(Socket socket, InputStream in, long deadline) throws IOException {
    byte[] unread = new byte[HEAD_LIMIT];
    for (long drained = 0; drained < DRAIN_LIMIT; ) {
      waitUntil(socket, deadline);
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
