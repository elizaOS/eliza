// spec/os/signIn/flow.md, "Story: Sign in with a code, Google or a second factor"; spec/os/signIn/flow.md, "Story: Re-authenticate the signed-in account"; spec/os/signIn/credential.md, "Story: Keep me signed in without a second copy of my key"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.securestore.nativeonly.JsonCredentialSlots;
import ai.eliza.plugins.signin.DeviceKeyClient.Answer;
import ai.eliza.plugins.signin.DeviceKeyClient.Binding;
import ai.eliza.plugins.signin.DeviceKeyClient.Exchange;
import ai.eliza.plugins.signin.DeviceKeyClient.Grant;
import ai.eliza.plugins.signin.SignInPolicy.Failure;
import ai.eliza.plugins.signin.SignInPolicy.Stage;
import ai.eliza.plugins.signin.SignInRegistration.Environment;
import android.content.Context;
import java.io.File;
import java.net.URI;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Supplier;

public final class DeviceCustody implements SignInCustody {
  public record Bound(DeviceCredentialStore store, DeviceKeyClient client, AccountSession session) {}

  private static final int SLOT_LIMIT_BYTES = 16_384;
  private static final Map<String, Bound> BOUND = new HashMap<>();
  private static final ExecutorService VERIFY = Executors.newSingleThreadExecutor();

  public static synchronized Bound bound(Context context, String apiOrigin) {
    return bound(apiOrigin, () -> {
      JsonCredentialSlots slots = new JsonCredentialSlots(new File(context.getNoBackupFilesDir(), "eliza-sign-in-credential"),
        "eliza-sign-in-credential.v1", slot -> SLOT_LIMIT_BYTES);
      return new DeviceCredentialStore.Slots() {
        @Override public String read(String slot) throws Exception { return slots.read(slot); }
        @Override public void write(String slot, String value) throws Exception { slots.write(slot, value); }
        @Override public void remove(String slot) throws Exception { slots.remove(slot); }
      };
    });
  }

  public static synchronized Bound bound(String apiOrigin, Supplier<DeviceCredentialStore.Slots> slots) {
    String authority = DeviceCredentialStore.authorityDigest(apiOrigin);
    return BOUND.computeIfAbsent(authority, digest -> {
      DeviceCredentialStore store = new DeviceCredentialStore(slots.get(), digest, System::currentTimeMillis);
      DeviceKeyClient client = new DeviceKeyClient(URI.create(apiOrigin), store, Thread::sleep);
      store.onVerifyAccount(() -> VERIFY.execute(client::verifyAccount));
      return new Bound(store, client, new AccountSession(store, client));
    });
  }

  public static SignInCustody custody(Context context, SignInRegistration registration) {
    return new DeviceCustody(registration, environment -> bound(context, environment.apiOrigin));
  }

  public interface Binder {
    Bound bind(Environment environment);
  }

  private final SignInRegistration registration;
  private final Binder binder;

  public DeviceCustody(SignInRegistration registration, Binder binder) {
    this.registration = registration;
    this.binder = binder;
  }

  @Override public int beginSignIn(Environment environment) throws Refused {
    try { return binder.bind(environment).store().beginSignIn(); }
    catch (DeviceCredentialStore.StorageFailure failed) { throw new Refused(Failure.STORAGE); }
  }

  @Override public void signInEnded(Environment environment, int attempt) {
    try { binder.bind(environment).store().signInEnded(attempt); }
    catch (DeviceCredentialStore.StorageFailure failed) { return; }
  }

  @Override public Proof connect(int attempt, Environment environment, String accessToken) throws Refused {
    String state = SignInPolicy.newState(), verifier = SignInPolicy.newVerifier();
    Answer<Grant> answer = binder.bind(environment).client().connect(accessToken, binding(environment), state, SignInPolicy.s256(verifier), null);
    return switch (answer) {
      case Answer.Answered<Grant> answered -> new Proof(answered.value().code(), state, verifier);
      case Answer.Refused<Grant> refused -> throw new Refused(SignInPolicy.failureFor(Stage.EXCHANGE, refused.status(), refused.error(), refused.reason().wire()));
      case Answer.Unanswered<Grant> unanswered -> throw new Refused(Failure.UNAVAILABLE);
    };
  }

  @Override public String redeem(int attempt, Environment environment, Proof proof) throws Refused {
    Bound bound = binder.bind(environment);
    Exchange exchange;
    try { exchange = bound.client().exchange(attempt, binding(environment), new DeviceKeyClient.Proof(proof.code(), proof.state(), proof.verifier())); }
    catch (DeviceCredentialStore.StorageFailure failed) { throw new Refused(Failure.STORAGE); }
    switch (exchange) {
      case SIGNED_IN -> {
        CredentialReader.Credential held = bound.store().current();
        if (held == null) throw new Refused(Failure.CANCELLED);
        bound.client().settleDuties();
        return held.credentialId();
      }
      case REFUSED -> throw new Refused(Failure.EXPIRED);
      case UNANSWERED -> throw new Refused(Failure.UNAVAILABLE);
      case SUPERSEDED -> throw new Refused(Failure.CANCELLED);
      default -> throw new IllegalStateException(exchange.name());
    }
  }

  @Override public Held held(Environment environment) {
    CredentialReader.Credential held;
    try { held = binder.bind(environment).store().current(); }
    catch (DeviceCredentialStore.StorageFailure failed) { return null; }
    return held == null ? null : new Held(held.version(), held.credentialId(), held.value(), held.account(), held.keyExpiresAt());
  }

  @Override public boolean grantSession(Environment environment, Session session) {
    return binder.bind(environment).session().grant(session.account(), session.accessToken(), session.refreshToken(), session.accessExpiresAt());
  }

  @Override public void signOut(Environment environment) {
    Bound bound = binder.bind(environment);
    bound.session().drop();
    bound.store().signOut();
    bound.client().settleDuties();
  }

  private Binding binding(Environment environment) {
    return new Binding(registration.clientId, environment.name, environment.redirectUri);
  }
}
