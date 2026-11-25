// spec/os/signIn/cloudRequests.md, "Story: Let my agent read my mail without holding a mail credential"; spec/os/agentService/config.md, "Only a cloud launch is handed the mail broker, by its address and a bearer for that launch, never a credential"; spec/os/signIn/cloudRequests.md, "The agent reaches the broker only by a bodiless GET on the loopback host, without an origin, with the current launch's bearer"; spec/os/signIn/cloudRequests.md, "The broker forwards only the owner's Gmail account list and search, with the lease, while the launch's owner holds it"; spec/os/signIn/cloudRequests.md, "The agent gets the cloud's status and body, or a refusal naming why nothing was read, and never the credential that read it"
package ai.eliza.plugins.signin;

import ai.eliza.os.agent.AgentCredentials;
import ai.eliza.os.agent.BrokerLaunches;
import ai.eliza.os.agent.GoogleBroker;
import ai.eliza.plugins.signin.CredentialPolicy.Account;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.InetAddress;
import java.net.Socket;
import java.net.SocketException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

public final class GoogleBrokerJourney {
  private static final AgentCredentials.Account OWNER = new AgentCredentials.Account("user-1", "org-1");
  private static final CloudRequests.MailAuthority OWNER_LEASE = new CloudRequests.MailAuthority(new Account("user-1", "org-1"), 3);
  private static final String ACCOUNTS = "/api/v1/eliza/google/accounts?side=owner";
  private static final String SEARCH = "/api/v1/eliza/google/gmail/search?side=owner&grantId=g1&query=in%3Ainbox&maxResults=25";

  private GoogleBrokerJourney() {}

  public static String ask(GoogleBroker.Endpoint endpoint, String method, String target, String bearer, String extraHeaders, String body) throws IOException {
    try (Socket socket = new Socket(InetAddress.getByAddress(new byte[] {127, 0, 0, 1}), endpoint.port())) {
      socket.setSoTimeout(10_000);
      String request = method + " " + GoogleBroker.PATH + target + " HTTP/1.1\r\nHost: 127.0.0.1:" + endpoint.port() + "\r\n"
        + (bearer == null ? "" : "Authorization: Bearer " + bearer + "\r\n") + extraHeaders
        + (body == null ? "" : "Content-Length: " + body.length() + "\r\n") + "Connection: close\r\n\r\n" + (body == null ? "" : body);
      OutputStream out = socket.getOutputStream();
      out.write(request.getBytes(StandardCharsets.ISO_8859_1));
      out.flush();
      InputStream in = socket.getInputStream();
      ByteArrayOutputStream reply = new ByteArrayOutputStream();
      in.transferTo(reply);
      String text = reply.toString(StandardCharsets.UTF_8);
      int split = text.indexOf("\r\n\r\n");
      if (text.length() < 12) return "closed unanswered";
      return text.substring(9, 12) + " " + (split < 0 ? "" : text.substring(split + 4));
    }
  }

  public static String read(GoogleBroker.Endpoint endpoint, String target) throws IOException {
    return ask(endpoint, "GET", target, endpoint.bearer(), "", null);
  }

  private static String readOnceAdmitted(GoogleBroker.Endpoint endpoint, String target) throws IOException, InterruptedException {
    for (long until = System.nanoTime() + 10_000_000_000L; ; Thread.sleep(100)) {
      String reply;
      try { reply = read(endpoint, target); }
      catch (java.net.SocketException reset) { reply = "closed unanswered"; }
      if (!reply.equals("closed unanswered") || System.nanoTime() > until) return reply;
    }
  }

  private static String take(String what, Object value) { return CredentialJson.quote(what) + ":" + CredentialJson.quote(String.valueOf(value)); }

  private static long closedAfterMs(Socket socket) throws IOException {
    long began = System.nanoTime();
    socket.setSoTimeout(10_000);
    try {
      if (socket.getInputStream().read() >= 0) throw new IllegalStateException("The broker answered a connection it should have closed");
    } catch (SocketException reset) {
      if (socket.isClosed()) throw reset;
    }
    return (System.nanoTime() - began) / 1_000_000;
  }

  private static List<Socket> connections(GoogleBroker.Endpoint endpoint, int count) throws IOException {
    List<Socket> held = new ArrayList<>();
    for (int at = 0; at < count; at++) held.add(new Socket(InetAddress.getByAddress(new byte[] {127, 0, 0, 1}), endpoint.port()));
    return held;
  }

  private static String listening(GoogleBroker.Endpoint endpoint) throws IOException {
    try (Socket socket = new Socket(InetAddress.getByAddress(new byte[] {127, 0, 0, 1}), endpoint.port())) { return "listening"; }
    catch (ConnectException refused) { return "closed"; }
  }

  private static GoogleBroker.Endpoint opened(BrokerLaunches.Launch launch) {
    return launch.open(true, OWNER, failed -> { throw new IllegalStateException(failed); });
  }

  public static void main(String[] args) throws Exception {
    AtomicReference<Account> signedIn = new AtomicReference<>(OWNER_LEASE.account());
    AtomicReference<CloudRequests.MailAuthority> authority = new AtomicReference<>(OWNER_LEASE);
    AtomicReference<CloudRequests.Outcome> answer = new AtomicReference<>();
    AtomicReference<RuntimeException> custodyFailure = new AtomicReference<>();
    List<String> forwarded = new CopyOnWriteArrayList<>();
    List<String> reported = new CopyOnWriteArrayList<>();
    List<String> seen = new ArrayList<>();
    GoogleBrokerHost.MailReads reads = new GoogleBrokerHost.MailReads() {
      @Override public GoogleBrokerHost.Standing standing() {
        Account account = signedIn.get();
        return new GoogleBrokerHost.Standing(account, account == null ? 0 : OWNER_LEASE.version(), authority.get());
      }
      @Override public CloudRequests.Outcome read(CloudRequests.MailAuthority expected, String target) {
        RuntimeException failure = custodyFailure.get();
        if (failure != null) throw failure;
        forwarded.add(target + (OWNER_LEASE.equals(expected) ? " as owner" : " as " + expected));
        return answer.get();
      }
    };
    try (GoogleBrokerHost broker = new GoogleBrokerHost(reads, failure -> reported.add(failure.getMessage()))) {
      GoogleBroker.Endpoint first = broker.open(OWNER);
      answer.set(new CloudRequests.Answered(200, null, "application/json", null, "{\"accounts\":[]}".getBytes(StandardCharsets.UTF_8), null));
      seen.add(take("accounts", read(first, ACCOUNTS)));
      seen.add(take("search", read(first, SEARCH)));
      seen.add(take("messageRead", read(first, "/api/v1/eliza/google/gmail/read?messageId=m1")));
      seen.add(take("unlistedField", read(first, "/api/v1/eliza/google/gmail/search?side=owner&messageId=m1")));
      seen.add(take("calendarFeed", read(first, "/api/v1/eliza/google/calendar/feed?grantId=g1")));
      seen.add(take("outsideThePrefix", ask(first, "GET", "", first.bearer(), "", null)));
      seen.add(take("post", ask(first, "POST", ACCOUNTS, first.bearer(), "", "{}")));
      seen.add(take("withBody", ask(first, "GET", ACCOUNTS, first.bearer(), "", "{}")));
      seen.add(take("withOrigin", ask(first, "GET", ACCOUNTS, first.bearer(), "Origin: https://evil.test\r\n", null)));
      seen.add(take("headTooLarge", ask(first, "GET", ACCOUNTS, first.bearer(), "X-Padding: " + "p".repeat(8_192) + "\r\n", null)));
      seen.add(take("withoutBearer", ask(first, "GET", ACCOUNTS, null, "", null)));
      seen.add(take("wrongBearer", ask(first, "GET", ACCOUNTS, "x".repeat(64), "", null)));
      GoogleBroker.Endpoint second = broker.open(OWNER);
      seen.add(take("samePortForNextLaunch", second.port() == first.port() && !second.bearer().equals(first.bearer())));
      seen.add(take("previousLaunchBearer", read(first, ACCOUNTS)));
      seen.add(take("currentLaunchBearer", read(second, ACCOUNTS)));
      signedIn.set(new Account("user-2", "org-1"));
      authority.set(new CloudRequests.MailAuthority(new Account("user-2", "org-1"), 3));
      seen.add(take("anotherOwnerSignedIn", read(second, ACCOUNTS)));
      signedIn.set(null);
      authority.set(null);
      seen.add(take("signedOut", read(second, ACCOUNTS)));
      signedIn.set(OWNER_LEASE.account());
      seen.add(take("ownerWithoutLease", read(second, ACCOUNTS)));
      authority.set(new CloudRequests.MailAuthority(new Account("user-2", "org-1"), 3));
      seen.add(take("leaseOfAnotherAccount", read(second, ACCOUNTS)));
      authority.set(OWNER_LEASE);
      custodyFailure.set(new IllegalStateException("the secure store could not be read"));
      seen.add(take("custodyFailed", read(second, ACCOUNTS)));
      custodyFailure.set(null);
      seen.add(take("reported", String.join(",", reported)));
      answer.set(new CloudRequests.Failed(CloudRequests.Failure.MAIL_LEASE_UPGRADE_REQUIRED));
      seen.add(take("withoutLease", read(second, ACCOUNTS)));
      answer.set(new CloudRequests.Failed(CloudRequests.Failure.SIGN_IN_REQUIRED));
      seen.add(take("ownerChangedInFlight", read(second, ACCOUNTS)));
      answer.set(new CloudRequests.Failed(CloudRequests.Failure.NETWORK));
      seen.add(take("offline", read(second, ACCOUNTS)));
      answer.set(new CloudRequests.Failed(CloudRequests.Failure.REPLY_TOO_LARGE));
      seen.add(take("oversize", read(second, ACCOUNTS)));
      answer.set(new CloudRequests.Answered(401, null, "application/json", null,
        "{\"error\":\"authentication_required\",\"reason\":\"credential_revoked\"}".getBytes(StandardCharsets.UTF_8), null));
      seen.add(take("cloudRefusal", read(second, ACCOUNTS)));
      answer.set(new CloudRequests.Answered(200, null, "application/json", null, "{\"accounts\":[]}".getBytes(StandardCharsets.UTF_8), null));
      List<String> unclosed = new CopyOnWriteArrayList<>();
      AtomicInteger relaunches = new AtomicInteger();
      BrokerLaunches launches = new BrokerLaunches(failure -> unclosed.add(failure.getMessage()));
      launches.install(broker);
      BrokerLaunches.Launch service = launches.launch(relaunches::incrementAndGet);
      GoogleBroker.Endpoint cloudLaunch = opened(service);
      seen.add(take("handedToOwnKeyLaunch", service.open(false, OWNER, failed -> { throw new IllegalStateException(failed); })));
      seen.add(take("cloudBearerAfterOwnKeyLaunch", read(cloudLaunch, ACCOUNTS)));
      GoogleBroker.Endpoint unspawned = opened(service);
      service.revoke();
      seen.add(take("spawnFailedBearer", read(unspawned, ACCOUNTS)));
      GoogleBroker.Endpoint exited = opened(service);
      service.revoke();
      seen.add(take("exitedLaunchBearer", read(exited, ACCOUNTS)));
      BrokerLaunches.Launch ending = launches.launch(relaunches::incrementAndGet);
      opened(ending);
      GoogleBroker.Endpoint relaunched = opened(service);
      ending.end();
      seen.add(take("relaunchAfterEarlierServiceEnded", read(relaunched, ACCOUNTS)));
      seen.add(take("endedServiceOpens", opened(ending)));
      List<Socket> idle = connections(relaunched, 8);
      try (Socket beyond = new Socket(InetAddress.getByAddress(new byte[] {127, 0, 0, 1}), relaunched.port())) {
        seen.add(take("beyondCapacityClosedAtOnce", closedAfterMs(beyond) < 2_000));
      }
      long idleClosed = closedAfterMs(idle.get(0));
      seen.add(take("idleClosedAtDeadline", idleClosed > 3_000 && idleClosed < 9_000));
      for (Socket held : idle) held.close();
      String afterIdle = readOnceAdmitted(relaunched, ACCOUNTS);
      seen.add(take("readAfterIdle", afterIdle));
      try (GoogleBrokerHost replacement = new GoogleBrokerHost(reads, failure -> reported.add(failure.getMessage()));
           GoogleBrokerHost third = new GoogleBrokerHost(reads, failure -> reported.add(failure.getMessage()))) {
        launches.install(replacement);
        seen.add(take("relaunchAskedOfTheHolder", relaunches.get() + " " + service.replaced()));
        seen.add(take("replacedServesItsLaunch", read(relaunched, ACCOUNTS)));
        service.revoke();
        seen.add(take("replacedClosedOnceRevoked", listening(relaunched)));
        String reopened;
        try { reopened = String.valueOf(broker.open(OWNER)); }
        catch (GoogleBroker.Closed refused) { reopened = refused.getMessage(); }
        seen.add(take("closedBrokerOpens", reopened));
        List<String> unavailable = new ArrayList<>();
        seen.add(take("closedBrokerHandedToALaunch", GoogleBroker.forLaunch(true, OWNER, broker, failed -> unavailable.add(failed.getClass().getSimpleName())) + " " + unavailable));
        GoogleBroker.Endpoint next = opened(service);
        seen.add(take("nextLaunchReadsThroughReplacement", read(next, ACCOUNTS)));
        service.revoke();
        List<Socket> waiting = connections(next, 8);
        Thread.sleep(500);
        launches.install(third);
        long closing = System.nanoTime();
        for (Socket queued : waiting.subList(4, 8)) closedAfterMs(queued);
        seen.add(take("queuedClosedWithAnUnheldReplacedBroker", (System.nanoTime() - closing) / 1_000_000 < 2_000 && "closed".equals(listening(next))));
        for (Socket held : waiting) held.close();
        seen.add(take("relaunchesAsked", relaunches.get()));
        seen.add(take("unclosed", String.join(",", unclosed)));
      }
      seen.add(take("forwarded", String.join(",", forwarded)));
    }
    System.out.println("{" + String.join(",", seen) + "}");
    System.exit(0);
  }
}
