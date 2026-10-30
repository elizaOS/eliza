package ai.eliza.plugins.agent.runtime;

import ai.eliza.plugins.securestore.nativeonly.CredentialMutationConductor;
import ai.eliza.plugins.securestore.nativeonly.CredentialSlotMutation;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

/** Exercises the shared commit boundary while a real child process is retired. */
public final class ResidentCredentialConductorTest {
  private static void check(boolean value, String reason) {
    if (!value) throw new AssertionError(reason);
  }

  private static final class Host implements CredentialMutationConductor.Host, AutoCloseable {
    final Object lifecycle = new Object(), credentials = new Object();
    final Process child;
    final CredentialShutdownLease lease = new CredentialShutdownLease();
    boolean current = true, acknowledge = true, supersede, stopping, finished;
    int commits, stops;
    long epoch, clockReads;
    Host() throws Exception {
      child = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
          "-cp", System.getProperty("java.class.path"), ResidentCredentialConductorTest.class.getName(), "child").start();
      check("ready".equals(new java.io.BufferedReader(new java.io.InputStreamReader(child.getInputStream())).readLine()), "real child became ready");
    }
    public Object lifecycleLock() { return lifecycle; }
    public Object credentialLock() { return credentials; }
    public long beginRetirement() {
      check(Thread.holdsLock(lifecycle) && !Thread.holdsLock(credentials), "retirement releases the credential lock");
      stopping = true;
      return ++epoch;
    }
    public void requireCurrent(long expected) {
      check(Thread.holdsLock(lifecycle), "owner check holds lifecycle");
      if (!current || epoch != expected) throw new IllegalStateException("Superseded owner");
    }
    public long requestStop() {
      check(Thread.holdsLock(lifecycle) && !Thread.holdsLock(credentials), "stop dispatch holds no credential lock");
      stops++;
      child.destroy();
      return lease.acquire();
    }
    public boolean stopped() throws Exception {
      check(!Thread.holdsLock(lifecycle) && !Thread.holdsLock(credentials), "process observation holds no owner lock");
      boolean dead = child.waitFor(2, TimeUnit.SECONDS);
      if (supersede) current = false;
      return dead;
    }
    public boolean stopAcknowledged(long request) {
      lease.acknowledge(request, acknowledge && !child.isAlive());
      return lease.isConfirmed(request);
    }
    public long elapsedRealtime() { return !acknowledge ? ++clockReads * 16_000 : 0; }
    public void sleep(long millis) throws InterruptedException { Thread.sleep(millis); }
    public void finishMutation(long expected, long request, boolean attempted, boolean committed) {
      check(Thread.holdsLock(lifecycle) && !Thread.holdsLock(credentials), "finish holds lifecycle and no store lock");
      if (expected == epoch) {
        finished = true;
        if (current && (!attempted || committed)) lease.release(request);
      }
    }
    public <T> T commit(CredentialMutationConductor.Mutation<T> mutation) throws Exception {
      check(Thread.holdsLock(lifecycle) && Thread.holdsLock(credentials), "commit holds lifecycle then credential lock");
      check(!child.isAlive(), "old child cannot outlive credential commit");
      commits++;
      return mutation.commit();
    }
    public void close() throws Exception {
      child.destroyForcibly();
      check(child.waitFor(5, TimeUnit.SECONDS), "child cleanup finished");
    }
  }

  private static CredentialMutationConductor.Mutation<String> change() {
    return new CredentialMutationConductor.Mutation<String>() {
      public boolean requiresShutdown() { return true; }
      public String commit() { return "committed"; }
    };
  }

  /** Real file readback and a real process, with only the host's key/store port replaced. */
  private static final class Vault implements AutoCloseable {
    final Host host = new Host();
    final Path directory = java.nio.file.Files.createTempDirectory("resident-credential-");
    final CredentialIntentFence intents = new CredentialIntentFence(host.lifecycle);
    final ResidentCredentialStore store;
    long intent = intents.reserve(), generation;
    Vault() throws Exception {
      store = new ResidentCredentialStore(new ResidentCredentialStore.Slots() {
        public String read(String name) throws Exception {
          Path file = directory.resolve(name);
          return java.nio.file.Files.exists(file) ? java.nio.file.Files.readString(file) : null;
        }
        public void write(String name, String value) throws Exception {
          check(Thread.holdsLock(host.credentials), "slot writes hold vault");
          java.nio.file.Files.writeString(directory.resolve(name), value);
        }
        public void remove(String name) throws Exception {
          check(Thread.holdsLock(host.credentials), "slot removals hold vault");
          java.nio.file.Files.deleteIfExists(directory.resolve(name));
        }
      }, new ResidentCredentialStore.Authority() {
        public Object credentialLock() { return host.credentials; }
        public void assertCurrent() { if (intent != intents.current()) throw new IllegalStateException("Intent changed"); }
        public <T> T mutate(Runnable extra, CredentialMutationConductor.Mutation<T> change) throws Exception {
          return CredentialMutationConductor.mutate(host, () -> { assertCurrent(); extra.run(); }, change);
        }
        public long epoch() { synchronized (host.lifecycle) { return generation; } }
        public long intent() { return intents.current(); }
        public <T> T withEpoch(long expected, java.util.concurrent.Callable<T> action) throws Exception {
          synchronized (host.lifecycle) { synchronized (host.credentials) {
            if (expected != generation) throw new IllegalStateException("Owner changed");
            return action.call();
          } }
        }
        public void changed() { generation++; }
        public boolean admissionReadable() { return !host.stopping; }
      }, new ResidentCredentialStore.Compatibility() {
        public void beforeMutation() { }
        public void cloudChanged() { }
        public void clearPendingReturn() { }
      }, "provider", "cloud", "other-cloud");
    }
    <T> T external(String name, String value, java.util.concurrent.Callable<T> write) throws Exception {
      return CredentialSlotMutation.replace(host, () -> intents.require(intent), () -> {
        Path file = directory.resolve(name);
        return java.nio.file.Files.exists(file) ? java.nio.file.Files.readString(file) : null;
      }, value, write, () -> { generation++; return null; });
    }
    public void close() throws Exception {
      host.close();
      try (var files = java.nio.file.Files.list(directory)) {
        for (Path file : (Iterable<Path>) files::iterator) java.nio.file.Files.delete(file);
      }
      java.nio.file.Files.delete(directory);
    }
  }

  private static void externalStoreMutations() throws Exception {
    try (Vault vault = new Vault()) {
      java.nio.file.Files.writeString(vault.directory.resolve("session"), "old");
      check(vault.external("session", "new", () -> {
        check(!vault.host.child.isAlive(), "generic set waits for real resident retirement");
        java.nio.file.Files.writeString(vault.directory.resolve("session"), "new");
        return true;
      }), "generic set reports its actual result");
      check(vault.host.lease.isReleased(1) && vault.generation == 1, "confirmed set releases its exact lease");
      check(vault.external("session", null, () -> java.nio.file.Files.deleteIfExists(vault.directory.resolve("session"))), "generic remove reports its actual result");
      check(!java.nio.file.Files.exists(vault.directory.resolve("session")) && vault.generation == 2, "remove reads back absence");
      vault.store.mutateSlot("unrelated", null, "value", false);
      check(vault.host.stops == 2, "unrelated slot follows lock order without resident shutdown");
    }
    try (Vault vault = new Vault()) {
      java.nio.file.Files.writeString(vault.directory.resolve("session"), "old");
      vault.intents.reserve();
      try {
        vault.external("session", "stale", () -> { throw new AssertionError("stale queued set executed"); });
        throw new AssertionError("stale queued intent admitted");
      } catch (IllegalStateException expected) { }
      check(vault.host.stops == 0 && "old".equals(java.nio.file.Files.readString(vault.directory.resolve("session"))), "stale queue neither stops nor writes");
    }
    try (Vault vault = new Vault()) {
      java.nio.file.Files.writeString(vault.directory.resolve("session"), "old");
      vault.host.acknowledge = false;
      try {
        vault.external("session", null, () -> { throw new AssertionError("remove ran after failed stop"); });
        throw new AssertionError("unconfirmed remove admitted");
      } catch (IllegalStateException expected) { }
      check("old".equals(java.nio.file.Files.readString(vault.directory.resolve("session"))) && !vault.host.lease.isReleased(1), "failed stop preserves credential and start fence");
    }
    for (boolean partial : new boolean[] {false, true}) try (Vault vault = new Vault()) {
      java.nio.file.Files.writeString(vault.directory.resolve("session"), "old");
      try {
        vault.external("session", "new", () -> {
          if (partial) {
            java.nio.file.Files.writeString(vault.directory.resolve("session"), "new");
            throw new IllegalStateException("write returned uncertain");
          }
          return true;
        });
        throw new AssertionError("unconfirmed commit admitted");
      } catch (IllegalStateException expected) { }
      check(!vault.host.lease.isReleased(1), "missing readback or post-write error retains fence");
      check((partial ? "new" : "old").equals(java.nio.file.Files.readString(vault.directory.resolve("session"))), "failure never invents rollback");
    }
  }

  public static void main(String[] args) throws Exception {
    if (args.length > 0) {
      System.out.println("ready");
      System.out.flush();
      System.in.read();
      return;
    }
    try (Host host = new Host()) {
      check("committed".equals(CredentialMutationConductor.mutate(host, () -> {}, change())), "acknowledged retirement commits");
      check(host.stops == 1 && host.commits == 1 && host.finished, "one stop and one commit");
    }
    try (Host host = new Host()) {
      host.acknowledge = false;
      try { CredentialMutationConductor.mutate(host, () -> {}, change()); throw new AssertionError("unconfirmed stop committed"); }
      catch (IllegalStateException expected) { check(expected.getMessage().contains("unconfirmed"), "exact stop acknowledgement is required"); }
      check(host.commits == 0 && host.finished && host.stopping, "failed stop releases mutation but retains the start fence");
    }
    try (Host host = new Host()) {
      host.supersede = true;
      try { CredentialMutationConductor.mutate(host, () -> { if (!host.current) throw new IllegalStateException("Owner changed"); }, change()); throw new AssertionError("superseded owner committed"); }
      catch (IllegalStateException expected) { /* Owner changed after observation, before commit. */ }
      check(host.commits == 0 && host.finished && host.stopping, "newer owner wins without writing old credential");
    }
    try (Host host = new Host()) {
      try {
        CredentialMutationConductor.mutate(host, () -> {}, new CredentialMutationConductor.Mutation<Void>() {
          public boolean requiresShutdown() { return true; }
          public Void commit() {
            try { host.lease.beforeStart(); throw new AssertionError("start entered between ACK and commit"); }
            catch (IllegalStateException fenced) { }
            throw new IllegalStateException("uncertain commit");
          }
        });
        throw new AssertionError("failed commit returned");
      } catch (IllegalStateException expected) { check("uncertain commit".equals(expected.getMessage()), "commit error retained"); }
      check(!host.lease.isReleased(1), "failed commit retains exact lease");
    }
    CredentialShutdownLease lease = new CredentialShutdownLease();
    long first = lease.acquire();
    check(!lease.release(first), "unconfirmed stop cannot release");
    check(lease.retry(first) == first, "failed stop retries same owner");
    lease.acknowledge(first, true);
    final java.util.concurrent.atomic.AtomicBoolean refused = new java.util.concurrent.atomic.AtomicBoolean();
    Thread external = new Thread(() -> {
      try { lease.beforeStart(); } catch (IllegalStateException fenced) { refused.set(true); }
    });
    external.start(); external.join(2000);
    check(!external.isAlive() && refused.get(), "external start after ACK waits for credential commit release");
    long newer = lease.acquire();
    check(!lease.release(first), "stale release cannot unlock a newer mutation");
    lease.acknowledge(first, true);
    check(!lease.isConfirmed(newer), "stale ACK cannot confirm a newer mutation");
    lease.acknowledge(newer, false);
    check(!lease.release(newer), "failed stop stays latched");
    check(lease.retry(newer) == newer, "current failed stop remains retryable");
    lease.acknowledge(newer, true);
    check(lease.release(newer), "current committed or cancelled mutation can release");
    lease.beforeStart();
    check(!lease.release(newer), "start supersedes the retired request");
    externalStoreMutations();
    System.out.println("PASS shared resident credential conductor with real child retirement, exact acknowledgement and supersession");
  }
}
