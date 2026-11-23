// spec/os/signIn/credential.md, "The lease belongs to the active key, and its access token lives at most a quarter hour, in memory only"; spec/os/signIn/credential.md, "A lease reader starts a refresh only when none is in flight, and a rotated secret is used only once the secure store reads it back"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.signin.CredentialPolicy.Lease;
import ai.eliza.plugins.signin.DeviceCredentialStore.SessionRead;
import ai.eliza.plugins.signin.DeviceKeyClient.Answer;
import ai.eliza.plugins.signin.DeviceKeyClient.Rotated;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

public final class DeviceLease {
  public record Held(int version, String token) {
    @Override public String toString() { return "Held[version=" + version + "]"; }
  }

  private final DeviceCredentialStore store;
  private final DeviceKeyClient client;
  private final Runnable rotated;
  private String access;
  private CompletableFuture<Void> inFlight;

  public DeviceLease(DeviceCredentialStore store, DeviceKeyClient client, Runnable rotated) {
    this.store = store;
    this.client = client;
    this.rotated = rotated;
  }

  public Held accessToken() {
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
    int version = CredentialPolicy.leaseVersionOf(store.state().lease());
    Answer<Rotated> answer = client.rotateLease();
    boolean taken = false;
    synchronized (this) {
      if (answer instanceof Answer.Answered<Rotated> answered) {
        Rotated next = answered.value();
        taken = store.leaseRotated(version, next.refresh(), next.accessExpiresAt(), next.refreshExpiresAt()) == DeviceCredentialStore.Kept.KEPT;
        access = taken ? next.access() : access;
      } else {
        store.leaseUnanswered();
      }
      if (inFlight == mine) inFlight = null;
      mine.complete(null);
    }
    if (taken) rotated.run();
    synchronized (this) { return store.leaseUsable() ? bound() : null; }
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
