// spec/os/signIn/credential.md, "Story: Keep me signed in without a second copy of my key"; spec/os/signIn/credential.md, "Story: Sign out or reset cleanly"; spec/os/signIn/credential.md, "Story: Confirm it is me before a billing change"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.securestore.nativeonly.NativeSecureStore;
import ai.eliza.plugins.signin.CredentialPolicy.Account;
import ai.eliza.plugins.signin.CredentialPolicy.MailLeaseUpgrade;
import ai.eliza.plugins.signin.DeviceKeyClient.Acknowledgement;
import ai.eliza.plugins.signin.DeviceKeyClient.Answer;
import ai.eliza.plugins.signin.DeviceKeyClient.Binding;
import ai.eliza.plugins.signin.DeviceKeyClient.Exchange;
import ai.eliza.plugins.signin.DeviceKeyClient.Grant;
import ai.eliza.plugins.signin.SignInPolicy.Failure;
import ai.eliza.plugins.signin.SignInPolicy.CloudReply;
import ai.eliza.plugins.signin.SignInRegistration.Environment;
import android.content.Context;
import java.net.URI;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

public final class DeviceCustody implements SignInCustody {
  private record Authority(DeviceCredentialStore store, DeviceKeyClient client, AccountSession session, DeviceLease lease) {}

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

  public static LegacyCredentialAuthority legacyCredentials(Context context, String apiOrigin) {
    return new LegacyCredentialAuthority(authority(context, apiOrigin).client());
  }

  public static final class LegacyCredentialAuthority {
    private final DeviceKeyClient client;

    private LegacyCredentialAuthority(DeviceKeyClient client) {
      this.client = client;
    }

    public Answer<Acknowledgement> acknowledge(String credentialId, String secret) {
      return client.ack(credentialId, secret);
    }

    public Answer<Account> user(String secret) {
      return client.user(secret);
    }

    public boolean revoke(String secret) {
      return client.revoke(secret);
    }
  }

  public static String accountBinding(Context context, String apiOrigin, String currentSecret) {
    return authority(context, apiOrigin).store().accountBinding(currentSecret);
  }

  public static void maintain(Context context, String apiOrigin) {
    Authority authority = authority(context, apiOrigin);
    CredentialPolicy.State state = authority.store().state();
    if (state.lease() instanceof CredentialPolicy.Lease.Held held
        && held.refreshExpiresAt() - state.now() <= TimeUnit.DAYS.toMillis(7)
        && authority.lease().accessToken() == null && authority.store().lease() != null)
      throw new IllegalStateException("Cloud device lease refresh is pending");
    authority.client().renewIfDue();
    authority.client().settleDuties();
    if (authority.store().renewDue() || authority.store().pendingRenewal() != null)
      throw new IllegalStateException("Cloud device renewal is pending");
  }

  public static boolean deviceOnly(Context context, String apiOrigin) {
    CredentialPolicy.State state = authority(context, apiOrigin).store().state();
    return state.custody() instanceof CredentialPolicy.Custody.SignedOut
      && state.attempt() instanceof CredentialPolicy.Attempt.NoAttempt;
  }

  public static CloudRequests.Custody cloud(Context context, String apiOrigin) {
    Authority authority = authority(context, apiOrigin);
    return new CloudRequests.Custody(authority.store(), authority.session(), authority.lease());
  }

  public static void reset(Context context, SignInRegistration registration) {
    for (Environment environment : registration.environments()) {
      Authority authority = authority(context, environment.apiOrigin);
      authority.session().drop();
      authority.store().reset();
      DUTIES.execute(authority.client()::settleDuties);
    }
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
    store.onRenewKey(() -> DUTIES.execute(client::renew));
    Authority created = new Authority(store, client, new AccountSession(store, client), new DeviceLease(store, client, () -> DUTIES.execute(client::renewIfDue)));
    AUTHORITIES.put(apiOrigin, created);
    DUTIES.execute(client::settleDuties);
    DUTIES.execute(client::renewIfDue);
    return created;
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

  @Override public MailLeaseUpgrade mailLeaseUpgrade(Environment environment) {
    return CredentialPolicy.mailLeaseUpgrade(authority(environment).store().state());
  }

  @Override public int beginMailLeaseUpgrade(Environment environment, MailLeaseUpgrade expected) throws Refused {
    try {
      int attempt = authority(environment).store().beginMailLeaseUpgrade(expected);
      if (attempt == 0) throw new Refused(Failure.REJECTED);
      return attempt;
    } catch (DeviceCredentialStore.StorageFailure unstored) {
      throw new Refused(Failure.UNAVAILABLE);
    }
  }

  @Override public void signInEnded(Environment environment, int attempt) {
    Authority authority = authority(environment);
    boolean upgrade = authority.store().isMailLeaseUpgrade(attempt);
    authority.store().signInEnded(attempt);
    if (upgrade) DUTIES.execute(authority.client()::settleDuties);
  }

  @Override public Proof connect(int attempt, Environment environment, String accessToken) throws Refused {
    Authority authority = authority(environment);
    if (!authority.store().state().attempt().equals(new CredentialPolicy.Attempt.Exchanging(attempt))) throw new Refused(Failure.CANCELLED);
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
    boolean upgrade = authority.store().isMailLeaseUpgrade(attempt);
    try {
      exchange = authority.client().exchange(attempt, binding(environment), new DeviceKeyClient.Proof(proof.code(), proof.state(), proof.verifier()));
    } catch (DeviceCredentialStore.StorageFailure unstored) {
      throw new Refused(Failure.UNAVAILABLE);
    } finally {
      if (upgrade) DUTIES.execute(authority.client()::settleDuties);
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
    DUTIES.execute(authority.client()::settleDuties);
  }
}
