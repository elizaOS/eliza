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
  private static final String NATIVE_GOOGLE = "/steward/auth/oauth/google/native/";
  private static final String PROVIDERS = "/steward/auth/providers";
  private static final String LOGOUT = "/steward/auth/logout";

  interface Readiness {
    boolean advertises(URI endpoint, String version) throws IOException;
  }

  private record ApprovalProof(String state, String verifier, JSONObject body) {}
  private record NativeApproval(ApprovalProof proof, String deviceCredential) {}

  private final CodeSignIn.Http http;
  private final Readiness readiness;
  private final String appClientId;
  private final SignInRegistration.Environment environment;
  private final String tenantId;
  private final String googleClientId;
  private final URI endpoint;

  public SharedPasswordBackup(SignInRegistration registration, SignInRegistration.Environment environment,
      String tenantId, String googleClientId) {
    this(CodeSignIn.CONNECTION, PasswordBackupApproval::advertisesNative, registration, environment, tenantId, googleClientId);
  }

  SharedPasswordBackup(CodeSignIn.Http http, Readiness readiness, SignInRegistration registration,
      SignInRegistration.Environment environment, String tenantId, String googleClientId) {
    if (environment != registration.environment(environment.name)
        || !tenantId.matches("[A-Za-z0-9_-]{1,128}") || !googleClientId.matches("[A-Za-z0-9_-]{1,128}")) {
      throw new IllegalArgumentException("Invalid shared password backup registration");
    }
    this.http = http;
    this.readiness = readiness;
    this.appClientId = registration.clientId;
    this.environment = environment;
    this.tenantId = tenantId;
    this.googleClientId = googleClientId;
    this.endpoint = URI.create(environment.apiOrigin + BACKUP);
  }

  public boolean available() {
    try {
      return canonicalReady() || legacyReady();
    } catch (IOException | RuntimeException unavailable) {
      return false;
    }
  }

  private boolean canonicalReady() throws IOException {
    URI canonical = URI.create(endpoint + "/readiness?clientId=" + encode(appClientId)
      + "&environment=" + encode(environment.name) + "&redirectUri=" + encode(environment.redirectUri)
      + "&approval=native-google");
    return readiness.advertises(canonical, "3");
  }

  private boolean legacyReady() throws IOException {
    URI legacy = URI.create(endpoint + "/readiness?clientId=" + encode(appClientId));
    if (!readiness.advertises(legacy, "2")) return false;
    CodeSignIn.Answer discovery = http.send("GET", environment.apiOrigin + PROVIDERS
      + "?tenantId=" + encode(tenantId) + "&clientId=" + encode(googleClientId), null, null);
    JSONObject app = discovery.body().optJSONObject("nativeGoogleApp");
    return discovery.status() == 200 && app != null && googleClientId.equals(app.opt("clientId"))
      && Boolean.TRUE.equals(app.opt("ready"));
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
    requireActive(active);
    String verifier = SignInPolicy.newVerifier();
    NativeApproval nativeApproval = null;
    CodeSignIn.Answer reply;
    if (canonicalReady()) {
      if (deviceCredential == null || !deviceCredential.matches("eliza_mobile_[0-9a-f]{64}")) {
        throw new IOException("An acknowledged native device is required");
      }
      requireActive(active);
      ApprovalProof proof = approvalProof(purpose);
      nativeApproval = new NativeApproval(proof, deviceCredential);
      reply = post(BACKUP + "/native/challenge", CodeSignIn.json(
        "approval", proof.body(), "googleChallenge", SignInPolicy.s256(verifier)), deviceCredential);
    } else {
      if (!legacyReady()) throw new IOException("Native password backup verification is unavailable");
      requireActive(active);
      reply = post(NATIVE_GOOGLE + "challenge", CodeSignIn.json(
        "tenantId", tenantId, "clientId", googleClientId, "codeChallenge", SignInPolicy.s256(verifier),
        "codeChallengeMethod", "S256"), null);
    }
    JSONObject body = reply.body();
    String id = body.optString("challengeId", "");
    String nonce = body.optString("nonce", "");
    String audience = body.optString("serverClientId", "");
    long now = System.currentTimeMillis();
    long expires = SignInPolicy.instant(body.opt("expiresAt"));
    if (reply.status() != 200 || (nativeApproval == null && !Boolean.TRUE.equals(body.opt("ok"))) || id.isEmpty() || id.length() > 256
        || !SignInPolicy.validNonce(nonce) || !SignInPolicy.validServerClientId(audience)
        || expires <= now || expires - now > SignInPolicy.MAX_CHALLENGE_LIFETIME_MS) {
      throw new IOException("Native password backup verification is unavailable");
    }
    requireActive(active);
    return new Attempt(new GoogleSignIn.Challenge(id, nonce, audience, expires, verifier), purpose, owner, active, nativeApproval);
  }

  public final class Attempt {
    private final GoogleSignIn.Challenge challenge;
    private final Purpose purpose;
    private final Owner owner;
    private final BooleanSupplier active;
    private final NativeApproval nativeApproval;
    private boolean used;

    private Attempt(GoogleSignIn.Challenge challenge, Purpose purpose, Owner owner, BooleanSupplier active, NativeApproval nativeApproval) {
      this.challenge = challenge;
      this.purpose = purpose;
      this.owner = owner;
      this.active = active;
      this.nativeApproval = nativeApproval;
    }

    public GoogleSignIn.Challenge challenge() { return challenge; }

    public PasswordBackupApproval approve(GoogleSignIn.Picked.Token picked, BooleanSupplier confirm) throws IOException {
      claim();
      if (picked == null || !SignInPolicy.validIdToken(picked.idToken())) throw new IOException("Native Google verification is required");
      requireCurrent();
      if (nativeApproval != null) {
        if (!confirm.getAsBoolean()) throw new IOException("Password backup consent was declined");
        requireCurrent();
        ApprovalProof proof = nativeApproval.proof();
        CodeSignIn.Answer answer = post(BACKUP + "/native/approve", CodeSignIn.json(
          "approval", proof.body(), "challengeId", challenge.challengeId(), "googleVerifier", challenge.verifier(),
          "idToken", picked.idToken(), "consent", true), nativeApproval.deviceCredential());
        return admit(answer, proof, false);
      }
      CodeSignIn.Answer reply = post(NATIVE_GOOGLE + "verify", CodeSignIn.json(
        "tenantId", tenantId, "clientId", googleClientId, "challengeId", challenge.challengeId(),
        "idToken", picked.idToken(), "codeVerifier", challenge.verifier()), null);
      if (reply.status() != 200) throw new IOException("Native Google verification was refused");
      JSONObject response = reply.body();
      JSONObject nested = response.optJSONObject("data");
      JSONObject session = nested != null && !response.has("token") ? nested : response;
      String token = session.optString("token", "");
      if (!SignInPolicy.validBearer(token) || token.startsWith("eliza_") || token.startsWith("pbackup_")) {
        throw new IOException("A fresh Steward session is required");
      }
      try {
        Object mfa = session.opt("mfaRequired");
        if (mfa != null && !Boolean.FALSE.equals(mfa)) throw new IOException("Native Google verification requires another factor");
        requireCurrent();
        if (!confirm.getAsBoolean()) throw new IOException("Password backup consent was declined");
        requireCurrent();
        return grant(token);
      } finally {
        revoke(token, session.optString("refreshToken", ""));
      }
    }

    private synchronized void claim() throws IOException {
      if (used) throw new IOException("Native password backup was already attempted");
      used = true;
    }

    private void requireCurrent() throws IOException {
      requireActive(active);
      if (System.currentTimeMillis() >= challenge.expiresAt()) throw new IOException("Native password backup verification expired");
    }

    private PasswordBackupApproval grant(String shortLivedSession) throws IOException {
      ApprovalProof proof = approvalProof(purpose);
      return admit(post(BACKUP, proof.body(), shortLivedSession), proof, true);
    }

    private PasswordBackupApproval admit(CodeSignIn.Answer answer, ApprovalProof proof, boolean legacy) throws IOException {
      if (answer.status() != 200) throw new IOException("Password backup approval was refused");
      requireCurrent();
      JSONObject body = answer.body();
      if (!body.has("revision")) throw new IOException("Missing password backup revision");
      Object code = body.has("code") && body.isNull("code") ? null : body.opt("code");
      if (!body.has("code")) throw new IOException("Missing password backup code");
      Grant grant = new Grant(code, body.optString("scope", null), body.optString("ownerId", null),
        body.opt("organizationId"), body.isNull("revision") ? null : body.opt("revision"), body.opt("present"));
      return legacy
        ? PasswordBackupApproval.admitNative(endpoint, purpose, proof.state(), proof.verifier(), owner, grant, active)
        : PasswordBackupApproval.admit(endpoint, purpose, proof.state(), proof.verifier(), owner, grant, active);
    }
  }

  private void revoke(String token, String refreshToken) {
    try {
      JSONObject body = SignInPolicy.validBearer(refreshToken) ? CodeSignIn.json("refreshToken", refreshToken) : new JSONObject();
      post(LOGOUT, body, token);
    } catch (IOException | RuntimeException unavailable) {
      return;
    }
  }

  private CodeSignIn.Answer post(String path, JSONObject body, String token) throws IOException {
    return http.post(environment.apiOrigin + path, body, token);
  }

  private static void requireActive(BooleanSupplier active) throws IOException {
    if (!active.getAsBoolean()) throw new IOException("Password backup account changed");
  }

  private static String encode(String value) throws IOException {
    return URLEncoder.encode(value, StandardCharsets.UTF_8.name());
  }
}
