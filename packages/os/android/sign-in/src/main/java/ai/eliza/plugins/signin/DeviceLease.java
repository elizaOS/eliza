// spec/os/signIn/credential.md, "The lease belongs to the active key, and its access token lives at most a quarter hour, in memory only"; spec/os/signIn/credential.md, "A lease reader starts a refresh only when none is in flight, and a rotated secret is used only once the secure store reads it back"
package ai.eliza.plugins.signin;

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
  private record Refresh(int version, CompletableFuture<Void> finished) {}

  private final DeviceCredentialStore store;
  private final DeviceKeyClient client;
  private final Runnable rotated;
  private Held access;
  private Refresh inFlight;

  public DeviceLease(DeviceCredentialStore store, DeviceKeyClient client, Runnable rotated) {
    this.store = store;
    this.client = client;
    this.rotated = rotated;
  }

  public Held accessToken() {
    Refresh mine = null, theirs = null;
    int version;
    synchronized (this) {
      var read = store.readLease();
      version = read.version();
      switch (read.stage()) {
        case USABLE -> { return bound(version); }
        case NONE -> { access = null; return null; }
        case AWAIT_REFRESH -> theirs = inFlight;
        case START_REFRESH -> mine = inFlight = new Refresh(version, new CompletableFuture<>());
      }
    }
    if (mine == null) return theirs == null || theirs.version() != version ? null : await(theirs);
    Answer<Rotated> answer = new Answer.Unanswered<>();
    boolean taken = false;
    try {
      answer = client.rotateLease(version);
    } finally {
      synchronized (this) {
        try {
          if (answer instanceof Answer.Answered<Rotated> answered) {
            Rotated next = answered.value();
            taken = store.leaseRotated(version, next.refresh(), next.accessExpiresAt(), next.refreshExpiresAt()) == DeviceCredentialStore.Kept.KEPT;
            if (taken) access = new Held(version, next.access());
          } else {
            store.leaseUnanswered(version);
          }
        } finally {
          if (inFlight == mine) inFlight = null;
          mine.finished().complete(null);
        }
      }
    }
    if (taken) rotated.run();
    synchronized (this) { return bound(version); }
  }

  private Held await(Refresh theirs) {
    try {
      theirs.finished().get(AccountSession.WAIT_MS, TimeUnit.MILLISECONDS);
    } catch (InterruptedException interrupted) {
      Thread.currentThread().interrupt();
      return null;
    } catch (ExecutionException | TimeoutException unfinished) {
      return null;
    }
    synchronized (this) { return bound(theirs.version()); }
  }

  private Held bound(int version) {
    int current = store.usableLeaseVersion();
    if (access != null && access.version() != current) access = null;
    return version == current ? access : null;
  }
}
