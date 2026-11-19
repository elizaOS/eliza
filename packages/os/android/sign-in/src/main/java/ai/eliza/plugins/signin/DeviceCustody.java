// spec/os/signIn/credential.md, "Story: Keep me signed in without a second copy of my key"; spec/os/signIn/credential.md, "Story: Sign out or reset cleanly"; spec/os/signIn/credential.md, "Story: Confirm it is me before a billing change"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.securestore.nativeonly.NativeSecureStore;
import ai.eliza.plugins.signin.DeviceKeyClient.Answer;
import ai.eliza.plugins.signin.DeviceKeyClient.Binding;
import ai.eliza.plugins.signin.DeviceKeyClient.Exchange;
import ai.eliza.plugins.signin.DeviceKeyClient.Grant;
import ai.eliza.plugins.signin.SignInPolicy.Failure;
import ai.eliza.plugins.signin.SignInPolicy.Stage;
import android.content.Context;
import java.net.URI;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class DeviceCustody implements SignInCustody, CloudRequests.Custody {
  private record Authority(String apiOrigin, DeviceCredentialStore store, DeviceKeyClient client, AccountSession session) {}

  private record Begun(String apiOrigin, int attempt) {}

  private static final Map<String, Authority> AUTHORITIES = new HashMap<>();
  private static final ExecutorService DUTIES = Executors.newSingleThreadExecutor();

  private final Context context;
  private final SignInRegistration registration;
  private final Map<Integer, Begun> begun = new HashMap<>();
  private int attempts;
  private String held;

  private DeviceCustody(Context context, SignInRegistration registration) {
    this.context = context;
    this.registration = registration;
    for (SignInRegistration.Environment environment : registration.environments())
      if (held == null && authority(context, environment.apiOrigin).store().current() != null) held = environment.apiOrigin;
    if (held == null) held = registration.production().apiOrigin;
  }

  public static DeviceCustody open(Context context, SignInRegistration registration) {
    return new DeviceCustody(context.getApplicationContext(), registration);
  }

  public static CredentialReader reader(Context context, String apiOrigin) {
    return authority(context, apiOrigin).store();
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
    Authority created = new Authority(apiOrigin, store, client, new AccountSession(store, client));
    AUTHORITIES.put(apiOrigin, created);
    DUTIES.execute(client::settleDuties);
    return created;
  }

  private Authority authority(String apiOrigin) { return authority(context, apiOrigin); }

  private synchronized Authority heldAuthority() { return authority(held); }

  @Override public synchronized int beginSignIn() {
    attempts++;
    begun.put(attempts, null);
    return attempts;
  }

  @Override public void signInEnded(int attempt) {
    Begun bound;
    synchronized (this) { bound = begun.remove(attempt); }
    if (bound != null) authority(bound.apiOrigin()).store().signInEnded(bound.attempt());
  }

  private Begun bind(int attempt, SignInRegistration.Environment environment) throws Refused {
    synchronized (this) {
      if (!begun.containsKey(attempt)) throw new Refused(Failure.CANCELLED);
      Begun bound = begun.get(attempt);
      if (bound != null) {
        if (!bound.apiOrigin().equals(environment.apiOrigin)) throw new Refused(Failure.INVALID_REQUEST);
        return bound;
      }
    }
    Begun bound;
    try {
      bound = new Begun(environment.apiOrigin, authority(environment.apiOrigin).store().beginSignIn());
    } catch (IllegalStateException unstored) {
      throw new Refused(Failure.STORAGE);
    }
    synchronized (this) {
      if (!begun.containsKey(attempt)) {
        authority(bound.apiOrigin()).store().signInEnded(bound.attempt());
        throw new Refused(Failure.CANCELLED);
      }
      begun.put(attempt, bound);
    }
    return bound;
  }

  private Binding binding(SignInRegistration.Environment environment) {
    return new Binding(registration.clientId, environment.name, environment.redirectUri);
  }

  @Override public Proof connect(int attempt, SignInRegistration.Environment environment, String accessToken) throws Refused {
    bind(attempt, environment);
    String state = SignInPolicy.newState(), verifier = SignInPolicy.newVerifier();
    Answer<Grant> answer = authority(environment.apiOrigin).client().connect(accessToken, binding(environment), state, SignInPolicy.s256(verifier), null);
    if (answer instanceof Answer.Answered<Grant> granted) return new Proof(granted.value().code(), state, verifier);
    if (answer instanceof Answer.Refused<Grant> refused)
      throw new Refused(SignInPolicy.failureFor(Stage.EXCHANGE, refused.status(), refused.error(), refused.reason().wire()));
    throw new Refused(Failure.UNAVAILABLE);
  }

  @Override public String redeem(int attempt, SignInRegistration.Environment environment, Proof proof, String mintedAnswer) throws Refused {
    Begun bound = bind(attempt, environment);
    Authority authority = authority(environment.apiOrigin);
    Exchange exchange;
    try {
      exchange = authority.client().exchange(bound.attempt(), binding(environment),
        new DeviceKeyClient.Proof(proof.code(), proof.state(), proof.verifier()), mintedAnswer == null ? null : DeviceKeyClient.minted(mintedAnswer));
    } catch (IllegalStateException unstored) {
      throw new Refused(Failure.STORAGE);
    }
    switch (exchange) {
      case SIGNED_IN -> {
        CredentialReader.Credential current = authority.store().current();
        synchronized (this) { begun.remove(attempt); held = environment.apiOrigin; }
        if (current == null) throw new Refused(Failure.CANCELLED);
        return current.credentialId();
      }
      case REFUSED -> throw new Refused(Failure.EXPIRED);
      case SUPERSEDED -> throw new Refused(Failure.CANCELLED);
      case UNANSWERED -> throw new Refused(Failure.UNAVAILABLE);
      default -> throw new IllegalStateException(exchange.name());
    }
  }

  @Override public Held held() {
    CredentialReader.Credential current = heldAuthority().store().current();
    if (current == null) return null;
    return new Held(current.version(), current.credentialId(), current.value(),
      new Account(current.account().userId(), current.account().organizationId()), current.keyExpiresAt());
  }

  @Override public boolean grantSession(Session session) {
    return heldAuthority().session().grant(new CredentialPolicy.Account(session.account().userId(), session.account().organizationId()),
      session.accessToken(), session.refreshToken(), session.accessExpiresAt());
  }

  @Override public void signOut() {
    for (SignInRegistration.Environment environment : registration.environments()) {
      Authority authority = authority(environment.apiOrigin);
      authority.session().drop();
      authority.store().signOut();
      DUTIES.execute(authority.client()::settleDuties);
    }
  }

  public void reset() {
    for (SignInRegistration.Environment environment : registration.environments()) {
      Authority authority = authority(environment.apiOrigin);
      authority.session().drop();
      authority.store().reset();
      DUTIES.execute(authority.client()::settleDuties);
    }
  }

  @Override public CloudRequests.Key deviceKey(String apiOrigin) {
    CredentialReader.Credential current = authority(apiOrigin).store().current();
    return current == null ? null : new CloudRequests.Key(current.version(), current.value());
  }

  @Override public String accountSession(String apiOrigin) {
    return authority(apiOrigin).session().accessToken();
  }

  @Override public void keyRejected(String apiOrigin, long version, String reason) {
    if (version >= 1 && version <= Integer.MAX_VALUE) authority(apiOrigin).store().report401((int) version, reason);
  }

  @Override public void sessionRejected(String apiOrigin) {
    authority(apiOrigin).session().drop();
  }
}
