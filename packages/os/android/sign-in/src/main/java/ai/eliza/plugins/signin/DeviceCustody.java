// spec/os/signIn/credential.md, "Story: Keep me signed in without a second copy of my key"; spec/os/signIn/credential.md, "Story: Sign out or reset cleanly"; spec/os/signIn/credential.md, "Story: Confirm it is me before a billing change"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.securestore.nativeonly.NativeSecureStore;
import ai.eliza.plugins.securestore.nativeonly.TaskKeyCustody;
import ai.eliza.plugins.signin.DeviceKeyClient.Answer;
import ai.eliza.plugins.signin.DeviceKeyClient.Binding;
import ai.eliza.plugins.signin.DeviceKeyClient.Exchange;
import ai.eliza.plugins.signin.DeviceKeyClient.Grant;
import ai.eliza.plugins.signin.SignInPolicy.Failure;
import ai.eliza.plugins.signin.SignInPolicy.CloudReply;
import ai.eliza.plugins.signin.SignInRegistration.Environment;
import ai.eliza.plugins.signin.BrowserReturnPolicy.CredentialAction;
import ai.eliza.plugins.signin.CredentialPolicy.Notice;
import android.content.Context;
import android.util.Log;
import java.io.File;
import java.net.URI;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

public final class DeviceCustody implements SignInCustody {
  private record Authority(DeviceCredentialStore store, DeviceKeyClient client, AccountSession session, TaskKeyCustody taskKeys) {}

  private static final String TAG = "ElizaSignIn";

  private static final Map<String, Authority> AUTHORITIES = new HashMap<>();
  private static final ExecutorService DUTIES = Executors.newSingleThreadExecutor();

  private final Context context;
  private final SignInRegistration registration;

  private DeviceCustody(Context context, SignInRegistration registration) {
    this.context = context;
    this.registration = registration;
  }

  public static SignInCustody custody(Context context, SignInRegistration registration) {
    return new DeviceCustody(context.getApplicationContext(), registration);
  }

  public static CredentialReader reader(Context context, String apiOrigin) {
    return authority(context, apiOrigin).store();
  }

  public static CloudRequests.Custody cloud(Context context, String apiOrigin) {
    Authority authority = authority(context, apiOrigin);
    return new CloudRequests.Custody(authority.store(), authority.session());
  }

  public static TaskKeyCustody taskKeys(Context context, String apiOrigin) {
    return authority(context, apiOrigin).taskKeys();
  }

  public static boolean reset(Context context, SignInRegistration registration, long timeoutMs) {
    long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(Math.max(0, timeoutMs));
    List<Authority> ended = new ArrayList<>();
    List<Future<?>> asked = new ArrayList<>();
    for (Environment environment : registration.environments()) {
      Authority authority = authority(context, environment.apiOrigin);
      authority.session().drop();
      authority.store().reset();
      try { authority.taskKeys().reset(); }
      catch (Exception kept) { Log.e(TAG, "Task keys outlived a reset of the device credential", kept); }
      ended.add(authority);
      asked.add(DUTIES.submit(authority.client()::settleDuties));
    }
    BrowserSignIn.signedOut(context, registration, CredentialAction.RESET);
    for (Future<?> duty : asked) {
      try { duty.get(Math.max(0, deadline - System.nanoTime()), TimeUnit.NANOSECONDS); }
      catch (TimeoutException late) { return false; }
      catch (InterruptedException stopped) { Thread.currentThread().interrupt(); return false; }
      catch (ExecutionException failed) { Log.w(TAG, "Revoking a device key before a reset failed", failed.getCause()); return false; }
    }
    return ended.stream().allMatch(authority -> authority.store().state().duties().isEmpty());
  }

  private static synchronized Authority authority(Context context, String apiOrigin) {
    Authority known = AUTHORITIES.get(apiOrigin);
    if (known != null) return known;
    NativeSecureStore secure = new NativeSecureStore(context.getApplicationContext());
    DeviceCredentialStore store = new DeviceCredentialStore(new DeviceCredentialStore.Slots() {
      @Override public String read(String slot) throws Exception { return secure.get(slot); }
      @Override public void write(String slot, String value) throws Exception { secure.set(slot, value); }
      @Override public void remove(String slot) throws Exception { secure.remove(slot); }
    }, DeviceCredentialStore.authorityDigest(apiOrigin), System::currentTimeMillis);
    DeviceKeyClient client = new DeviceKeyClient(URI.create(apiOrigin), store, Thread::sleep);
    store.onVerifyAccount(() -> DUTIES.execute(client::verifyAccount));
    String digest = DeviceCredentialStore.authorityDigest(apiOrigin);
    TaskKeyCustody taskKeys = new TaskKeyCustody(new File(new File(context.getNoBackupFilesDir(), "task-keys"), digest), "eliza.task-key." + digest + ".", apiOrigin);
    CredentialReader.Credential held = store.current();
    if (held != null) taskKeys.accountVerified(taskAccount(held.account()));
    store.listen(notice -> {
      if (notice instanceof Notice.Announce announced) taskKeys.accountVerified(taskAccount(announced.account()));
      else if (notice instanceof Notice.SignedOutNotice) taskKeys.signedOut();
    });
    Authority created = new Authority(store, client, new AccountSession(store, client), taskKeys);
    AUTHORITIES.put(apiOrigin, created);
    DUTIES.execute(client::settleDuties);
    return created;
  }

  private static TaskKeyCustody.Account taskAccount(CredentialPolicy.Account account) {
    return new TaskKeyCustody.Account(account.userId(), account.organizationId());
  }

  private Authority authority(Environment environment) { return authority(context, environment.apiOrigin); }

  private Binding binding(Environment environment) {
    return new Binding(registration.clientId, environment.name, environment.redirectUri);
  }

  @Override public int beginSignIn(Environment environment) throws Refused {
    try {
      return authority(environment).store().beginSignIn();
    } catch (DeviceCredentialStore.StorageFailure unstored) {
      throw new Refused(Failure.UNAVAILABLE);
    }
  }

  @Override public void signInEnded(Environment environment, int attempt) {
    authority(environment).store().signInEnded(attempt);
  }

  @Override public Proof connect(int attempt, Environment environment, String accessToken) throws Refused {
    Authority authority = authority(environment);
    if (authority.store().generation() != attempt) throw new Refused(Failure.CANCELLED);
    String state = SignInPolicy.newState(), verifier = SignInPolicy.newVerifier();
    Answer<Grant> answer = authority.client().connect(accessToken, binding(environment), state, SignInPolicy.s256(verifier), null);
    if (answer instanceof Answer.Answered<Grant> granted) return new Proof(granted.value().code(), state, verifier);
    if (answer instanceof Answer.Refused<Grant> refused
      && SignInPolicy.refusal(refused.status(), refused.error(), refused.reason().wire()) instanceof CloudReply.Refused reply)
      throw new Refused(SignInPolicy.failureOf(false, reply.code(), reply.reason()));
    throw new Refused(Failure.UNAVAILABLE);
  }

  @Override public String redeem(int attempt, Environment environment, Proof proof) throws Refused {
    Authority authority = authority(environment);
    Exchange exchange;
    try {
      exchange = authority.client().exchange(attempt, binding(environment), new DeviceKeyClient.Proof(proof.code(), proof.state(), proof.verifier()));
    } catch (DeviceCredentialStore.StorageFailure unstored) {
      throw new Refused(Failure.UNAVAILABLE);
    }
    switch (exchange) {
      case SIGNED_IN -> {
        CredentialReader.Credential current = authority.store().current();
        if (current == null) throw new Refused(Failure.CANCELLED);
        return current.credentialId();
      }
      case REFUSED -> throw new Refused(Failure.EXPIRED);
      case SUPERSEDED -> throw new Refused(Failure.CANCELLED);
      case UNANSWERED -> throw new Refused(Failure.UNAVAILABLE);
      default -> throw new IllegalStateException(exchange.name());
    }
  }

  @Override public Held held(Environment environment) {
    CredentialReader.Credential current = authority(environment).store().current();
    if (current == null) return null;
    return new Held(current.version(), current.credentialId(), current.value(), current.account(), current.keyExpiresAt());
  }

  @Override public boolean grantSession(Environment environment, Session session) {
    return authority(environment).session().grant(session.account(), session.accessToken(), session.refreshToken(), session.accessExpiresAt());
  }

  @Override public void signOut(Environment environment) {
    Authority authority = authority(environment);
    authority.session().drop();
    authority.store().signOut();
    BrowserSignIn.signedOut(context, registration, CredentialAction.SIGN_OUT);
    DUTIES.execute(authority.client()::settleDuties);
  }
}
