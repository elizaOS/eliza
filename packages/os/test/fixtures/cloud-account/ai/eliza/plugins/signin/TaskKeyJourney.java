// spec/os/android/taskKeys.md, "Story: Keep each account's tasks under its own key"; spec/os/android/taskKeys.md, "The current account's key is released only as the storage key of a launch newer than every earlier one"; spec/os/android/taskKeys.md, "An account change, a sign-out or a reset retires the release"; spec/os/agentService/lifecycle.md, "A child is spawned only after the stale child is reaped, a key is held and every check passed"; spec/agent/host/launch.md, "The launch frame is one stdin line with the token, the epoch, and the optional credential and storage key"
package ai.eliza.plugins.signin;

import ai.eliza.os.agent.AgentCredentials;
import ai.eliza.os.agent.LaunchFrame;
import ai.eliza.plugins.securestore.nativeonly.CloudDeviceAccountJourney;
import ai.eliza.plugins.securestore.nativeonly.TaskKeyCustody;
import ai.eliza.plugins.signin.CredentialPolicy.Account;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.KeyStore;
import java.security.Provider;
import java.security.Security;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.locks.LockSupport;
import org.json.JSONArray;
import org.json.JSONObject;

public final class TaskKeyJourney {
  private static final String ORIGIN = "https://cloud.example";
  private static final String ALIAS = "eliza.task-key-journey.";
  private static final long NOW = 1_795_000_000_000L;
  private static final long KEY_EXPIRES = NOW + 30L * 24 * 60 * 60 * 1000;
  private static final Account FIRST = new Account("user-1", "org-1");
  private static final Account SECOND = new Account("user-2", "org-2");
  private static final Account UNNAMED = new Account("u".repeat(257), "org-3");

  private final Map<String, String> slots = Collections.synchronizedMap(new TreeMap<>());
  private final File directory = Files.createTempDirectory("task-key-journey").toFile();
  private final List<String> refusals = new ArrayList<>();
  private DeviceCredentialStore store;
  private AgentCredentials credentials;
  private int minted;

  private TaskKeyJourney() throws Exception { start(); }

  private void start() {
    store = new DeviceCredentialStore(new DeviceCredentialStore.Slots() {
      @Override public String read(String slot) { return slots.get(slot); }
      @Override public void write(String slot, String value) { slots.put(slot, value); }
      @Override public void remove(String slot) { slots.remove(slot); }
    }, DeviceCredentialStore.authorityDigest(ORIGIN), () -> NOW);
    credentials = new DeviceAgentCredentials(store, new TaskKeyCustody(directory, ALIAS, ORIGIN), refused -> refusals.add(refused.refusal.name()));
  }

  private void signIn(Account account) {
    String credentialId = "cred-" + ++minted;
    int attempt = store.beginSignIn();
    if (store.tokenAnswered(attempt, new DeviceCredentialStore.Token(credentialId, "eliza_mobile_" + credentialId, account, KEY_EXPIRES)) != DeviceCredentialStore.Kept.KEPT
        || store.acknowledged(attempt, credentialId, KEY_EXPIRES) != DeviceCredentialStore.Outcome.ACCEPTED)
      throw new IllegalStateException("the journey could not sign in " + account);
  }

  private String launch(long epoch) throws Exception {
    AgentCredentials.Active active = credentials.current();
    AgentCredentials.StorageKey released = credentials.storageKey(active.account(), epoch);
    String frame;
    try (released) {
      frame = frame(active, epoch, released);
    }
    if (released != null && !retired(released)) throw new IllegalStateException("a framed key stayed readable after its frame was written");
    return frame;
  }

  private static String frame(AgentCredentials.Active active, long epoch, AgentCredentials.StorageKey released) throws Exception {
    return new String(LaunchFrame.first(LaunchFrame.newToken(), epoch, LaunchFrame.Credential.of(active), released == null ? null : released.value()).encode(), StandardCharsets.UTF_8);
  }

  private static boolean retired(AgentCredentials.StorageKey key) { return key.value() == null; }

  // A launch's verify reads the account, then a sign-out commits and its notice reaches the listener before that verify
  // steps custody. The key the launch is answered must then be refused, or retired by the time the sign-out returns.
  private boolean signOutDuringVerify() throws Exception {
    signIn(FIRST);
    AtomicBoolean armed = new AtomicBoolean();
    Thread[] signer = new Thread[1];
    CredentialReader gated = new CredentialReader() {
      @Override public Credential current() { return store.current(); }
      @Override public Account account() {
        Account read = store.account();
        if (armed.compareAndSet(true, false)) {
          signer[0] = new Thread(store::signOut, "task-key-journey-sign-out");
          signer[0].start();
          awaitBlockedOrDone(signer[0]);
        }
        return read;
      }
      @Override public Subscription listen(Listener listener) { return store.listen(listener); }
      @Override public void report401(int version, String reason) { store.report401(version, reason); }
    };
    AgentCredentials racing = new DeviceAgentCredentials(gated, new TaskKeyCustody(new File(directory, "race"), ALIAS + "race.", ORIGIN), refused -> {});
    armed.set(true);
    AgentCredentials.StorageKey answered = racing.storageKey(launchAccount(FIRST), 1);
    signer[0].join(TimeUnit.SECONDS.toMillis(10));
    if (signer[0].isAlive()) throw new IllegalStateException("the sign-out did not finish");
    try {
      return store.current() == null && (answered == null || retired(answered)) && racing.storageKey(launchAccount(FIRST), 2) == null;
    } finally {
      if (answered != null) answered.close();
    }
  }

  private static void awaitBlockedOrDone(Thread thread) {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
    while (thread.getState() != Thread.State.BLOCKED && thread.getState() != Thread.State.TERMINATED) {
      if (System.nanoTime() > deadline) throw new IllegalStateException("the sign-out neither finished nor waited for the verify");
      LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(1));
    }
  }

  private void removeDirectory() throws IOException {
    Files.walkFileTree(directory.toPath(), new SimpleFileVisitor<>() {
      @Override public FileVisitResult visitFile(Path file, BasicFileAttributes attributes) throws IOException {
        Files.delete(file);
        return FileVisitResult.CONTINUE;
      }
      @Override public FileVisitResult postVisitDirectory(Path dir, IOException failed) throws IOException {
        if (failed != null) throw failed;
        Files.delete(dir);
        return FileVisitResult.CONTINUE;
      }
    });
  }

  private static AgentCredentials.Account launchAccount(Account account) {
    return new AgentCredentials.Account(account.userId(), account.organizationId());
  }

  private JSONObject walk() throws Exception {
    JSONObject seen = new JSONObject();
    seen.put("signedOutHasNoCredential", credentials.current() == null);
    signIn(FIRST);
    seen.put("first", launch(1));
    seen.put("sameEpochAskedAgain", credentials.storageKey(launchAccount(FIRST), 1) == null);
    seen.put("relaunch", launch(2));
    seen.put("anotherAccountAsked", credentials.storageKey(launchAccount(SECOND), 3) == null);

    AgentCredentials.Active framing = credentials.current();
    AgentCredentials.StorageKey held = credentials.storageKey(launchAccount(FIRST), 3);
    store.signOut();
    seen.put("retiredBySignOut", retired(held));
    seen.put("retiredBeforeFramed", frame(framing, 3, held));
    held.close();
    seen.put("askedAfterSignOut", credentials.current() == null && credentials.storageKey(launchAccount(FIRST), 4) == null);

    signIn(SECOND);
    seen.put("second", launch(4));
    store.signOut();
    signIn(FIRST);
    seen.put("signedInAgain", launch(5));

    start();
    seen.put("afterRestart", launch(6));

    KeyStore keystore = KeyStore.getInstance("AndroidKeyStore");
    keystore.load(null);
    for (String alias : Collections.list(keystore.aliases())) if (alias.startsWith(ALIAS)) keystore.deleteEntry(alias);
    seen.put("wrappingKeyLost", launch(7));

    store.signOut();
    signIn(UNNAMED);
    seen.put("unnamedAccount", launch(8));
    store.signOut();
    seen.put("signOutDuringVerify", signOutDuringVerify());
    seen.put("refusals", new JSONArray(refusals));
    return seen;
  }

  public static void main(String[] arguments) throws Exception {
    Security.addProvider(new Provider("AndroidKeyStore", "1.0", "Journey keystore") {
      {
        put("KeyStore.AndroidKeyStore", CloudDeviceAccountJourney.FakeKeyStore.class.getName());
        put("KeyGenerator.AES", CloudDeviceAccountJourney.FakeKeyGenerator.class.getName());
      }
    });
    TaskKeyJourney journey = new TaskKeyJourney();
    try {
      System.out.println(journey.walk());
    } finally {
      journey.removeDirectory();
    }
  }
}
