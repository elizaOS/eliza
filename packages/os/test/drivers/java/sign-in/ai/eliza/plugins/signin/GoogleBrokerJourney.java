// spec/os/signIn/cloudRequests.md, "Story: Let my agent read my mail without holding a mail credential"; spec/os/signIn/cloudRequests.md, "The agent reaches the broker only by a bodiless GET on the loopback host, without an origin, with the current launch's bearer"; spec/os/signIn/cloudRequests.md, "The broker forwards only the owner's Gmail account list and search, with the lease, while the launch's owner holds it"; spec/os/signIn/cloudRequests.md, "The agent gets the cloud's status and body, or a refusal naming why nothing was read, and never the credential that read it"
package ai.eliza.plugins.signin;

import ai.eliza.os.agent.AgentCredentials;
import ai.eliza.os.agent.GoogleBroker;
import ai.eliza.plugins.signin.CredentialPolicy.Account;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
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
      return text.substring(9, 12) + " " + (split < 0 ? "" : text.substring(split + 4));
    }
  }

  public static String read(GoogleBroker.Endpoint endpoint, String target) throws IOException {
    return ask(endpoint, "GET", target, endpoint.bearer(), "", null);
  }

  private static String take(String what, Object value) { return CredentialJson.quote(what) + ":" + CredentialJson.quote(String.valueOf(value)); }

  public static void main(String[] args) throws Exception {
    AtomicReference<CloudRequests.MailAuthority> authority = new AtomicReference<>(OWNER_LEASE);
    AtomicReference<CloudRequests.Outcome> answer = new AtomicReference<>();
    List<String> forwarded = new CopyOnWriteArrayList<>();
    List<String> seen = new ArrayList<>();
    try (GoogleBrokerHost broker = new GoogleBrokerHost(new GoogleBrokerHost.MailReads() {
      @Override public CloudRequests.MailAuthority authority() { return authority.get(); }
      @Override public CloudRequests.Outcome read(CloudRequests.MailAuthority expected, String target) {
        forwarded.add(target + (OWNER_LEASE.equals(expected) ? " as owner" : " as " + expected));
        return answer.get();
      }
    })) {
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
      seen.add(take("withoutBearer", ask(first, "GET", ACCOUNTS, null, "", null)));
      seen.add(take("wrongBearer", ask(first, "GET", ACCOUNTS, "x".repeat(64), "", null)));
      GoogleBroker.Endpoint second = broker.open(OWNER);
      seen.add(take("samePortForNextLaunch", second.port() == first.port() && !second.bearer().equals(first.bearer())));
      seen.add(take("previousLaunchBearer", read(first, ACCOUNTS)));
      seen.add(take("currentLaunchBearer", read(second, ACCOUNTS)));
      authority.set(new CloudRequests.MailAuthority(new Account("user-2", "org-1"), 3));
      seen.add(take("anotherOwnerSignedIn", read(second, ACCOUNTS)));
      authority.set(null);
      seen.add(take("signedOut", read(second, ACCOUNTS)));
      authority.set(OWNER_LEASE);
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
      seen.add(take("forwarded", String.join(",", forwarded)));
    }
    System.out.println("{" + String.join(",", seen) + "}");
    System.exit(0);
  }
}
