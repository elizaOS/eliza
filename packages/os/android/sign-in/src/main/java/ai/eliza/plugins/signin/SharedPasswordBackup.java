// spec/os/android/passwords/vault.md, "Shared backup is offered only when its exact native app is ready"; spec/os/android/passwords/vault.md, "Shared approval requires the registered cloud and the current owner"; spec/os/android/passwords/vault.md, "One native proof authorizes one backup action"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.securestore.nativeonly.PasswordBackupApproval;
import ai.eliza.plugins.securestore.nativeonly.PasswordBackupApproval.Grant;
import ai.eliza.plugins.securestore.nativeonly.PasswordBackupApproval.Owner;
import ai.eliza.plugins.securestore.nativeonly.PasswordBackupApproval.Purpose;
import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Objects;
import java.util.function.BooleanSupplier;
import org.json.JSONObject;

public final class SharedPasswordBackup {
  private static final String BACKUP = "/api/v1/app-auth/mobile/password-backup";

  interface Readiness {
    boolean advertises(URI endpoint, String version) throws IOException;
  }

  private record ApprovalProof(String state, String verifier, JSONObject body) {}

  private final CodeSignIn.Http http;
  private final Readiness readiness;
  private final String appClientId;
  private final SignInRegistration.Environment environment;
  private final URI endpoint;

  public SharedPasswordBackup(SignInRegistration registration, SignInRegistration.Environment environment) {
    this(CodeSignIn.CONNECTION, PasswordBackupApproval::advertisesNative, registration, environment);
  }

  SharedPasswordBackup(CodeSignIn.Http http, Readiness readiness, SignInRegistration registration,
      SignInRegistration.Environment environment) {
    if (environment != registration.environment(environment.name)) {
      throw new IllegalArgumentException("Invalid shared password backup registration");
    }
    this.http = http;
    this.readiness = readiness;
    this.appClientId = registration.clientId;
    this.environment = environment;
    this.endpoint = URI.create(environment.apiOrigin + BACKUP);
  }

  public boolean available() {
    try {
      return confirmedReadiness();
    } catch (IOException | RuntimeException unavailable) {
      return false;
    }
  }

  private boolean confirmedReadiness() throws IOException {
    URI probe = URI.create(endpoint + "/readiness?clientId=" + encode(appClientId)
      + "&environment=" + encode(environment.name) + "&redirectUri=" + encode(environment.redirectUri)
      + "&approval=native-google");
    return readiness.advertises(probe, "3");
  }

  private ApprovalProof approvalProof(Purpose purpose) throws IOException {
    String state = SignInPolicy.newState();
    String verifier = SignInPolicy.newVerifier();
    return new ApprovalProof(state, verifier, CodeSignIn.json(
      "clientId", appClientId, "environment", environment.name, "redirectUri", environment.redirectUri,
      "purpose", purpose.value(), "state", state, "codeChallenge", SignInPolicy.s256(verifier),
      "codeChallengeMethod", "S256"));
  }

  public Attempt begin(Purpose purpose, Owner owner, String deviceCredential, BooleanSupplier active) throws IOException {
    Objects.requireNonNull(purpose);
    if (owner == null || !SignInPolicy.validUuid(owner.accountId()) || !SignInPolicy.validUuid(owner.organizationId())) {
      throw new IOException("A verified account is required");
    }
    if (deviceCredential == null || !deviceCredential.matches("eliza_mobile_[0-9a-f]{64}")) {
      throw new IOException("An acknowledged native device is required");
    }
    requireActive(active);
    if (!confirmedReadiness()) throw new IOException("Native password backup verification is unavailable");
    requireActive(active);
    ApprovalProof proof = approvalProof(purpose);
    String verifier = SignInPolicy.newVerifier();
    CodeSignIn.Answer reply = post("/native/challenge", CodeSignIn.json(
      "approval", proof.body(), "googleChallenge", SignInPolicy.s256(verifier)), deviceCredential);
    JSONObject body = reply.body();
    String id = body.optString("challengeId", "");
    String nonce = body.optString("nonce", "");
    String audience = body.optString("serverClientId", "");
    long now = System.currentTimeMillis();
    long expires = SignInPolicy.instant(body.opt("expiresAt"));
    if (reply.status() != 200 || id.isEmpty() || id.length() > 256
        || !SignInPolicy.validNonce(nonce) || !SignInPolicy.validServerClientId(audience)
        || expires <= now || expires - now > SignInPolicy.MAX_CHALLENGE_LIFETIME_MS) {
      throw new IOException("Native password backup verification is unavailable");
    }
    requireActive(active);
    return new Attempt(new GoogleSignIn.Challenge(id, nonce, audience, expires, verifier), purpose, owner, active, proof, deviceCredential);
  }

  public final class Attempt {
    private final GoogleSignIn.Challenge challenge;
    private final Purpose purpose;
    private final Owner owner;
    private final BooleanSupplier active;
    private final ApprovalProof proof;
    private final String deviceCredential;
    private boolean used;

    private Attempt(GoogleSignIn.Challenge challenge, Purpose purpose, Owner owner, BooleanSupplier active,
        ApprovalProof proof, String deviceCredential) {
      this.challenge = challenge;
      this.purpose = purpose;
      this.owner = owner;
      this.active = active;
      this.proof = proof;
      this.deviceCredential = deviceCredential;
    }

    public GoogleSignIn.Challenge challenge() { return challenge; }

    public PasswordBackupApproval approve(GoogleSignIn.Picked.Token picked, BooleanSupplier confirm) throws IOException {
      claim();
      if (picked == null || !SignInPolicy.validIdToken(picked.idToken())) throw new IOException("Native Google verification is required");
      requireCurrent();
      if (!confirm.getAsBoolean()) throw new IOException("Password backup consent was declined");
      requireCurrent();
      CodeSignIn.Answer answer = post("/native/approve", CodeSignIn.json(
        "approval", proof.body(), "challengeId", challenge.challengeId(), "googleVerifier", challenge.verifier(),
        "idToken", picked.idToken(), "consent", true), deviceCredential);
      if (answer.status() != 200) throw new IOException("Password backup approval was refused");
      requireCurrent();
      JSONObject body = answer.body();
      if (!body.has("code") || !body.has("revision")) throw new IOException("Incomplete password backup approval");
      Grant grant = new Grant(body.isNull("code") ? null : body.opt("code"), body.optString("scope", null),
        body.optString("ownerId", null), body.opt("organizationId"),
        body.isNull("revision") ? null : body.opt("revision"), body.opt("present"));
      return PasswordBackupApproval.admit(endpoint, purpose, proof.state(), proof.verifier(), owner, grant, active);
    }

    private synchronized void claim() throws IOException {
      if (used) throw new IOException("Native password backup was already attempted");
      used = true;
    }

    private void requireCurrent() throws IOException {
      requireActive(active);
      if (System.currentTimeMillis() >= challenge.expiresAt()) throw new IOException("Native password backup verification expired");
    }
  }

  private CodeSignIn.Answer post(String suffix, JSONObject body, String token) throws IOException {
    return http.post(endpoint + suffix, body, token);
  }

  private static void requireActive(BooleanSupplier active) throws IOException {
    if (!active.getAsBoolean()) throw new IOException("Password backup account changed");
  }

  private static String encode(String value) throws IOException {
    return URLEncoder.encode(value, StandardCharsets.UTF_8.name());
  }
}
