// spec/os/signIn/credential.md, "Story: Confirm it is me before a billing change"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.signin.CredentialPolicy.Account;
import ai.eliza.plugins.signin.CredentialPolicy.RefreshAnswer;
import ai.eliza.plugins.signin.CredentialPolicy.Session;
import ai.eliza.plugins.signin.DeviceCredentialStore.SessionRead;
import ai.eliza.plugins.signin.DeviceKeyClient.Answer;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

public final class AccountSession {
  public static final String REFRESH = "/api/v1/auth/refresh";
  public static final long WAIT_MS = DeviceKeyClient.CONNECT_TIMEOUT_MS + DeviceKeyClient.READ_TIMEOUT_MS;

  private record Tokens(int version, String access, String refresh) {
    @Override public String toString() { return "Tokens[version=" + version + "]"; }
  }

  private record Rotated(String access, String refresh, long accessExpiresAt) {
    @Override public String toString() { return "Rotated[accessExpiresAt=" + accessExpiresAt + "]"; }
  }

  private final DeviceCredentialStore store;
  private final DeviceKeyClient client;
  private Tokens tokens;
  private CompletableFuture<Void> inFlight;

  public AccountSession(DeviceCredentialStore store, DeviceKeyClient client) {
    this.store = store;
    this.client = client;
  }

  public synchronized boolean grant(Account account, String accessToken, String refreshToken, long accessExpiresAt) {
    if (!store.grantSession(account, accessExpiresAt) || !(store.session() instanceof Session.Held held)) return false;
    tokens = new Tokens(held.version(), accessToken, refreshToken);
    return true;
  }

  public synchronized void drop() {
    tokens = null;
    store.dropSession();
  }

  public synchronized void dropIfCurrent(String rejected) {
    if (rejected != null && rejected.equals(bound())) drop();
  }

  public String accessToken() {
    CompletableFuture<Void> mine = null, theirs = null;
    Tokens refreshing = null;
    synchronized (this) {
      SessionRead read = store.readSession();
      switch (read) {
        case USABLE -> { return bound(); }
        case NONE -> { tokens = null; return null; }
        case AWAIT_REFRESH -> theirs = inFlight;
        case START_REFRESH -> {
          mine = inFlight = new CompletableFuture<>();
          refreshing = tokens;
        }
        default -> throw new IllegalStateException(read.name());
      }
    }
    if (mine == null) return theirs == null ? null : await(theirs);
    if (refreshing == null) {
      finish(mine, new RefreshAnswer.Refused(), null);
      return null;
    }
    Answer<Rotated> answer = client.ask("POST", REFRESH, null, "{\"refreshToken\":" + CredentialJson.quote(refreshing.refresh()) + "}", 200,
      body -> new Rotated(CredentialJson.text(body, "accessToken"), CredentialJson.text(body, "refreshToken"), CredentialJson.whole(body, "accessExpiresAt")));
    if (answer instanceof Answer.Answered<Rotated> answered) {
      Rotated rotated = answered.value();
      finish(mine, new RefreshAnswer.Refreshed(rotated.accessExpiresAt()), new Tokens(refreshing.version(), rotated.access(), rotated.refresh()));
    } else if (answer instanceof Answer.Refused<Rotated> refused && !refused.retryable()) {
      finish(mine, new RefreshAnswer.Refused(), null);
    } else {
      finish(mine, new RefreshAnswer.Unanswered(), refreshing);
    }
    synchronized (this) { return store.sessionUsable() ? bound() : null; }
  }

  private synchronized void finish(CompletableFuture<Void> mine, RefreshAnswer answer, Tokens next) {
    store.refreshAnswered(answer);
    tokens = next;
    if (inFlight == mine) inFlight = null;
    mine.complete(null);
  }

  private String await(CompletableFuture<Void> theirs) {
    try {
      theirs.get(WAIT_MS, TimeUnit.MILLISECONDS);
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
      return null;
    } catch (ExecutionException | TimeoutException unfinished) {
      return null;
    }
    synchronized (this) { return store.sessionUsable() ? bound() : null; }
  }

  private String bound() {
    if (tokens != null && store.session() instanceof Session.Held held && held.version() == tokens.version()) return tokens.access();
    tokens = null;
    return null;
  }
}
