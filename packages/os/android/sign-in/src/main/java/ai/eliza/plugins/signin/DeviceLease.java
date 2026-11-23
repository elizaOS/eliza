// spec/os/signIn/credential.md, "The lease belongs to the active key, and its access token lives at most a quarter hour, in memory only"; spec/os/signIn/credential.md, "A lease reader starts a refresh only when none is in flight, and a rotated secret is used only once the secure store reads it back"; spec/os/signIn/credential.md, "Only the lease renews the key, and a renewed key keeps the account and the lease"; spec/os/signIn/credential.md, "A daily job kept across reboots gives every spent duty one more try, refreshes a lease a day old and renews a key that is due"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.signin.CredentialPolicy.Lease;
import ai.eliza.plugins.signin.DeviceCredentialStore.SessionRead;
import ai.eliza.plugins.signin.DeviceKeyClient.Answer;
import ai.eliza.plugins.signin.DeviceKeyClient.Exchange;
import ai.eliza.plugins.signin.DeviceKeyClient.Rotated;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

public final class DeviceLease {
  public record Held(int version, String token) {
    @Override public String toString() { return "Held[version=" + version + "]"; }
  }

  private final DeviceCredentialStore store;
  private final DeviceKeyClient client;
  private final Executor duties;
  private String access;
  private CompletableFuture<Void> inFlight;

  public DeviceLease(DeviceCredentialStore store, DeviceKeyClient client, Executor duties) {
    this.store = store;
    this.client = client;
    this.duties = duties;
  }

  public Held accessToken() {
    return token(true);
  }

  public Exchange renewKey() {
    if (store.pendingRenewal() == null && token(false) == null) return Exchange.UNANSWERED;
    return client.renew();
  }

  public void renewKeyIfDue() {
    if (store.renewDue() || store.pendingRenewal() != null) renewKey();
  }

  public void runDailyJob() {
    store.retryDuties();
    client.settleDuties();
    if (store.leaseRefreshDue()) token(false);
    renewKeyIfDue();
  }

  private Held token(boolean renewAfterRotation) {
    CompletableFuture<Void> mine = null, theirs = null;
    synchronized (this) {
      SessionRead read = store.readLease();
      switch (read) {
        case USABLE -> { return bound(); }
        case NONE -> { access = null; return null; }
        case AWAIT_REFRESH -> theirs = inFlight;
        case START_REFRESH -> mine = inFlight = new CompletableFuture<>();
        default -> throw new IllegalStateException(read.name());
      }
    }
    if (mine == null) return theirs == null ? null : await(theirs);
    var rotation = new Object() { boolean settled, taken; };
    try {
      client.rotateLease((version, answer) -> {
        rotation.taken = written(version, answer);
        rotation.settled = true;
      });
    } finally {
      synchronized (this) {
        try {
          if (!rotation.settled) store.leaseUnanswered();
        } finally {
          if (inFlight == mine) inFlight = null;
          mine.complete(null);
        }
      }
    }
    if (rotation.taken && renewAfterRotation) duties.execute(this::renewKeyIfDue);
    synchronized (this) { return store.leaseUsable() ? bound() : null; }
  }

  private synchronized boolean written(int version, Answer<Rotated> answer) {
    if (!(answer instanceof Answer.Answered<Rotated> answered)) {
      store.leaseUnanswered();
      return false;
    }
    Rotated next = answered.value();
    boolean taken = store.leaseRotated(version, next.refresh(), next.accessExpiresAt(), next.refreshExpiresAt()) == DeviceCredentialStore.Kept.KEPT;
    if (taken) access = next.access();
    return taken;
  }

  private Held await(CompletableFuture<Void> theirs) {
    try {
      theirs.get(AccountSession.WAIT_MS, TimeUnit.MILLISECONDS);
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
      return null;
    } catch (ExecutionException | TimeoutException unfinished) {
      return null;
    }
    synchronized (this) { return store.leaseUsable() ? bound() : null; }
  }

  private Held bound() {
    if (access != null && store.leaseUsable() && store.state().lease() instanceof Lease.Held held) return new Held(held.version(), access);
    access = null;
    return null;
  }
}
