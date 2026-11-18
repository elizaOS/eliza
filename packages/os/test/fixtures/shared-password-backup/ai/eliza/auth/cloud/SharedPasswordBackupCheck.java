package ai.eliza.auth.cloud;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.net.URLConnection;
import java.net.URLStreamHandler;
import java.nio.charset.StandardCharsets;
import java.security.cert.Certificate;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;

public final class SharedPasswordBackupCheck {
  private static final String HOST = "cloud.example.test";
  private static final String OWNER = "c434cf76-4f5b-40b1-86ce-105d3e0a8737";
  private static final String ORGANIZATION = "b1289533-686e-4125-8276-e89296ebf089";
  private static final String TOKEN = "transient-steward-session-token";
  private static final String PROOF = "pbackup_" + "t".repeat(43);
  private static final byte[] SNAPSHOT = { 7, 8, 9 };
  private static final AtomicBoolean CURRENT = new AtomicBoolean(true);
  private static int approvals;
  private static int writes;
  private static int reads;
  private static boolean retireOnDownload;
  private static String readinessVersion;
  private static String approvalOrganization = ORGANIZATION;
  private static JSONObject authorization;

  public static void main(String[] args) throws Exception {
    URL.setURLStreamHandlerFactory(scheme -> !"https".equals(scheme) ? null : new URLStreamHandler() {
      @Override protected URLConnection openConnection(URL url) { return new Endpoint(url); }
    });
    var production = new CloudSignInEnvironment("production", HOST, HOST, "prod", "Cloud", "/auth/account/callback");
    var staging = new CloudSignInEnvironment("staging", "staging.example.test", "staging.example.test", "stage", "Cloud", "/auth/account/callback");
    var config = CloudSignInConfig.builder().clientId("test.eliza.consumer").deviceName("Tablet")
        .productName("Passwords").googleClientId("passwords").environment(production).build();

    rejects(() -> CloudPasswordBackup.approve(config, staging, TOKEN, CloudPasswordBackup.Purpose.SAVE, CURRENT::get));
    rejects(() -> CloudPasswordBackup.approve(config, production, "eliza_mobile_durable-device-key", CloudPasswordBackup.Purpose.SAVE, CURRENT::get));
    require(approvals == 0);
    require(OWNER.equals(CloudPasswordBackup.currentAccount(production, "eliza_mobile_durable-device-key")));
    require(!CloudPasswordBackup.available(config, production));
    readinessVersion = "2";
    require(CloudPasswordBackup.available(config, production));

    approvalOrganization = null;
    rejects(() -> CloudPasswordBackup.approve(config, production, TOKEN, CloudPasswordBackup.Purpose.SAVE, CURRENT::get));
    approvalOrganization = "invalid-organization";
    rejects(() -> CloudPasswordBackup.approve(config, production, TOKEN, CloudPasswordBackup.Purpose.SAVE, CURRENT::get));
    require(writes == 0);
    approvalOrganization = ORGANIZATION;

    var stale = CloudPasswordBackup.approve(config, production, TOKEN, CloudPasswordBackup.Purpose.SAVE, CURRENT::get);
    require(OWNER.equals(stale.ownerId()) && ORGANIZATION.equals(stale.organizationId()) && stale.present() && stale.current());
    CURRENT.set(false);
    rejects(() -> stale.run(stale.revision(), SNAPSHOT));
    require(writes == 0);

    CURRENT.set(true);
    var save = CloudPasswordBackup.approve(config, production, TOKEN, CloudPasswordBackup.Purpose.SAVE, CURRENT::get);
    require(save.run(save.revision(), SNAPSHOT).status() == 204);
    rejects(() -> save.run(save.revision(), SNAPSHOT));
    require(writes == 1);

    var read = CloudPasswordBackup.approve(config, production, TOKEN, CloudPasswordBackup.Purpose.READ, CURRENT::get);
    retireOnDownload = true;
    rejects(() -> read.run(null, null));
    require(reads == 1 && !read.current());
    System.out.println("Shared password approval remained current and single use");
  }

  private static final class Endpoint extends HttpsURLConnection {
    private final ByteArrayOutputStream request = new ByteArrayOutputStream();
    private byte[] answer;

    Endpoint(URL url) { super(url); }

    @Override public int getResponseCode() {
      require(HOST.equals(url.getHost()) && !getInstanceFollowRedirects());
      if (url.getPath().equals("/api/v1/app-auth/session")) {
        require("GET".equals(method) && "Bearer eliza_mobile_durable-device-key".equals(getRequestProperty("Authorization")));
        answer = json(new JSONObject().put("user", new JSONObject().put("id", OWNER)));
        return 200;
      }
      if (url.getPath().equals("/api/v1/app-auth/mobile/password-backup/readiness")) {
        require("GET".equals(method) && "clientId=test.eliza.consumer".equals(url.getQuery()));
        return 204;
      }
      require(url.getPath().equals("/api/v1/app-auth/mobile/password-backup"));
      if ("POST".equals(method)) {
        require(("Bearer " + TOKEN).equals(getRequestProperty("Authorization")));
        authorization = new JSONObject(request.toString(StandardCharsets.UTF_8));
        require("production".equals(authorization.getString("environment"))
            && "test.eliza.consumer".equals(authorization.getString("clientId"))
            && ("https://" + HOST + "/auth/account/callback").equals(authorization.getString("redirectUri"))
            && "S256".equals(authorization.getString("codeChallengeMethod")));
        approvals++;
        var approved = new JSONObject().put("code", PROOF).put("scope", "a".repeat(64))
            .put("ownerId", OWNER).put("revision", "\"1\"").put("present", true);
        if (approvalOrganization != null) approved.put("organizationId", approvalOrganization);
        answer = json(approved);
        return 200;
      }
      require(("Bearer " + PROOF).equals(getRequestProperty("Authorization"))
          && authorization.getString("state").equals(getRequestProperty("X-Backup-State"))
          && authorization.getString("codeChallenge").equals(CloudSignInFlow.s256(getRequestProperty("X-Backup-Verifier"))));
      if ("PUT".equals(method)) {
        require("save".equals(authorization.getString("purpose")) && "\"1\"".equals(getRequestProperty("If-Match"))
            && java.util.Arrays.equals(SNAPSHOT, request.toByteArray()));
        writes++;
        return 204;
      }
      require("GET".equals(method) && "read".equals(authorization.getString("purpose")));
      reads++;
      answer = SNAPSHOT;
      return 200;
    }

    @Override public OutputStream getOutputStream() { return request; }
    @Override public String getHeaderField(String name) {
      return switch (name) {
        case "ETag" -> "\"1\"";
        case "X-Password-Backup-Version" -> readinessVersion;
        default -> null;
      };
    }
    @Override public String getContentType() { return "application/octet-stream"; }
    @Override public InputStream getInputStream() {
      return new ByteArrayInputStream(answer) {
        @Override public synchronized int read(byte[] buffer, int start, int len) {
          int count = super.read(buffer, start, len);
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

  private static byte[] json(JSONObject answer) { return answer.toString().getBytes(StandardCharsets.UTF_8); }

  private static void require(boolean condition) {
    if (!condition) throw new AssertionError();
  }

  private static void rejects(Call action) throws Exception {
    try { action.run(); }
    catch (IOException refused) { return; }
    throw new AssertionError("Operation succeeded despite an invalid or inactive proof");
  }

  @FunctionalInterface private interface Call { void run() throws Exception; }
}
