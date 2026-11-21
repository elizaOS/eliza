// spec/os/signIn/browserReturn.md, "Story: Complete a browser sign-in only for the client that started it"; spec/os/signIn/browserReturn.md, "Story: Come back to the app after a failed browser sign-in"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.signin.CredentialPolicy.Attempt;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

public final class BrowserReturnPolicy {
  private BrowserReturnPolicy() {}

  public static final long PENDING_LIFETIME_MS = 10 * 60 * 1000L;
  public static final String AUTHORIZE = "/api/v1/auth/google/authorize";
  public static final String EXCHANGE = "/api/v1/auth/google/exchange";
  public static final Set<String> RETURN_ERRORS = Set.of("access_denied", "app_link_unverified", "mfa_required",
    "oauth_authentication_failed", "oauth_callback_incomplete", "oauth_identity_incomplete", "oauth_provider_unavailable",
    "oauth_redirect_invalid", "oauth_state_consumed", "oauth_state_expired", "oauth_state_invalid", "oauth_token_exchange_failed");
  private static final Pattern STATE = Pattern.compile("[A-Za-z0-9_-]{43}");
  private static final Pattern VERIFIER = Pattern.compile("[A-Za-z0-9._~-]{43,128}");
  private static final Pattern NAME = Pattern.compile("[a-z_]{1,16}");
  private static final Pattern VALUE = Pattern.compile("[A-Za-z0-9_.~-]{1,4096}");
  private static final int MAX_URL = 8192;

  public enum Owner { LIVE, ADOPTED }

  public enum Retirement { SETTLED, UNCONFIRMED }

  public enum CredentialAction { ANOTHER_SIGN_IN, SIGN_OUT, RESET }

  public record StartChecks(boolean registered, boolean originValid, boolean proofValid, boolean appLinkVerified) {}

  public record Pending(String client, String nonce, int generation, long expiresAt) {
    @Override public String toString() { return "Pending[client=" + client + ", generation=" + generation + ", expiresAt=" + expiresAt + "]"; }
  }

  public sealed interface BrowserAttempt {
    record None() implements BrowserAttempt {}
    record Waiting(String client, String nonce) implements BrowserAttempt {
      @Override public String toString() { return "Waiting[client=" + client + "]"; }
    }
    record Handed(String client, int generation, Owner owner) implements BrowserAttempt {}
  }

  public static final BrowserAttempt NO_ATTEMPT = new BrowserAttempt.None();

  public record State(CredentialPolicy.State credential, Pending record, BrowserAttempt attempt, Retirement retirement) {
    State with(CredentialPolicy.State c) { return new State(c, record, attempt, retirement); }
  }

  public static boolean startAdmitted(StartChecks checks) {
    return checks.registered() && checks.originValid() && checks.proofValid() && checks.appLinkVerified();
  }

  public static boolean canStart(String client, String nonce, StartChecks checks) {
    return client != null && !client.isEmpty() && validState(nonce) && startAdmitted(checks);
  }

  public static State start(State s, String client, String nonce) {
    CredentialPolicy.State c = CredentialPolicy.beginSignIn(s.credential());
    return new State(c, new Pending(client, nonce, c.generation(), s.credential().now() + PENDING_LIFETIME_MS),
      new BrowserAttempt.Waiting(client, nonce), Retirement.SETTLED);
  }

  public static boolean isWaiting(BrowserAttempt a) { return a instanceof BrowserAttempt.Waiting; }

  public static boolean adoptable(State s) {
    return s.attempt() instanceof BrowserAttempt.None && s.credential().attempt() instanceof Attempt.NoAttempt;
  }

  public static boolean returnAdmitted(State s) {
    Pending p = s.record();
    return p != null && p.generation() == s.credential().generation() && s.credential().now() < p.expiresAt()
      && (s.attempt().equals(new BrowserAttempt.Waiting(p.client(), p.nonce())) || adoptable(s));
  }

  public static CredentialPolicy.State endSignIn(int generation, CredentialPolicy.State c) {
    return CredentialPolicy.canSignInEnded(c, generation) ? CredentialPolicy.signInEnded(c, generation) : c;
  }

  public static boolean canReturned(State s, String client, String nonce) {
    Pending p = s.record();
    return s.retirement() == Retirement.SETTLED && p != null && p.client().equals(client) && sameSecret(p.nonce(), nonce);
  }

  public static State returned(State s, boolean burned) {
    Pending p = s.record();
    if (!returnAdmitted(s)) return s;
    if (burned) {
      Owner owner = isWaiting(s.attempt()) ? Owner.LIVE : Owner.ADOPTED;
      return new State(s.credential().with(new Attempt.Exchanging(p.generation())), null, new BrowserAttempt.Handed(p.client(), p.generation(), owner), s.retirement());
    }
    return new State(endSignIn(p.generation(), s.credential()), p, NO_ATTEMPT, Retirement.UNCONFIRMED);
  }

  public static boolean canElapse(long ms) { return ms > 0; }

  public static boolean waitingExpired(State s) {
    return isWaiting(s.attempt()) && s.record() != null && s.credential().now() >= s.record().expiresAt();
  }

  public static State expired(State s) {
    return waitingExpired(s) ? new State(endSignIn(s.record().generation(), s.credential()), s.record(), NO_ATTEMPT, s.retirement()) : s;
  }

  public static State credentialActed(State s, CredentialAction kind, CredentialPolicy.State acted) {
    boolean another = kind == CredentialAction.ANOTHER_SIGN_IN;
    return new State(acted, another ? s.record() : null, NO_ATTEMPT, another ? s.retirement() : Retirement.SETTLED);
  }

  public static CredentialPolicy.State act(CredentialPolicy.State c, CredentialAction kind) {
    return switch (kind) {
      case ANOTHER_SIGN_IN -> CredentialPolicy.beginSignIn(c);
      case SIGN_OUT -> CredentialPolicy.signOut(c).state();
      case RESET -> CredentialPolicy.reset(c).state();
    };
  }

  public static boolean canRetired(State s) {
    return s.retirement() == Retirement.UNCONFIRMED && s.attempt() instanceof BrowserAttempt.None;
  }

  public static State retired(State s, boolean burned) {
    return burned ? new State(s.credential(), null, s.attempt(), Retirement.SETTLED) : s;
  }

  public static boolean holds(State s) {
    CredentialPolicy.State c = s.credential();
    Pending p = s.record();
    if (c.generation() < 0 || (p != null && (p.generation() < 1 || p.generation() > c.generation()))) return false;
    if (s.attempt() instanceof BrowserAttempt.Waiting w && !(p != null && p.client().equals(w.client()) && p.nonce().equals(w.nonce())
        && p.generation() == c.generation() && c.now() < p.expiresAt() && c.attempt().equals(new Attempt.Exchanging(c.generation())))) return false;
    if (s.attempt() instanceof BrowserAttempt.Handed h && !(p == null && h.generation() == c.generation() && c.attempt().equals(new Attempt.Exchanging(h.generation())))) return false;
    return s.retirement() == Retirement.SETTLED || (s.attempt() instanceof BrowserAttempt.None && p != null);
  }

  public static boolean validState(String value) { return value != null && STATE.matcher(value).matches(); }

  public static boolean validVerifier(String value) { return value != null && VERIFIER.matcher(value).matches(); }

  public static boolean sameSecret(String a, String b) {
    return a != null && b != null && java.security.MessageDigest.isEqual(a.getBytes(StandardCharsets.US_ASCII), b.getBytes(StandardCharsets.US_ASCII));
  }

  public static StartChecks checks(SignInRegistration registration, SignInRegistration.Environment environment, String state, String verifier, boolean appLinkVerified) {
    boolean registered = environment != null && registration.environment(environment.name) == environment;
    boolean origin = registered && environment.apiOrigin.startsWith("https://") && environment.redirectUri.startsWith("https://" + environment.appLinkHost + "/");
    boolean proof = validState(state) && validVerifier(verifier) && validState(SignInPolicy.s256(verifier));
    return new StartChecks(registered, origin, proof, appLinkVerified);
  }

  public static String authorizeUrl(String clientId, SignInRegistration.Environment environment, String state, String verifier) {
    return environment.apiOrigin + AUTHORIZE + "?response_type=code&client_id=" + percent(clientId) + "&environment=" + percent(environment.name)
      + "&redirect_uri=" + percent(environment.redirectUri) + "&code_challenge=" + SignInPolicy.s256(verifier)
      + "&code_challenge_method=S256&state=" + state;
  }

  private static String percent(String value) {
    StringBuilder out = new StringBuilder();
    for (byte b : value.getBytes(StandardCharsets.UTF_8)) {
      int c = b & 0xff;
      if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') out.append((char) c);
      else out.append('%').append(String.format(Locale.ROOT, "%02X", c));
    }
    return out.toString();
  }

  public sealed interface Callback {
    record Code(String environment, String state, String code) implements Callback {
      @Override public String toString() { return "Code[environment=" + environment + "]"; }
    }
    record Error(String environment, String state, String error) implements Callback {
      @Override public String toString() { return "Error[environment=" + environment + ", error=" + error + "]"; }
    }
    record NoResult() implements Callback {}
  }

  public static Callback parseCallback(String text, List<SignInRegistration.Environment> environments) {
    if (text == null || text.length() > MAX_URL) return null;
    URI uri;
    try { uri = new URI(text); } catch (URISyntaxException invalid) { return null; }
    SignInRegistration.Environment environment = null;
    for (SignInRegistration.Environment candidate : environments) {
      if ("https".equals(uri.getScheme()) && candidate.appLinkHost.equals(uri.getRawAuthority()) && uri.getRawUserInfo() == null
          && uri.getPort() == -1 && candidate.redirectUri.equals("https://" + uri.getRawAuthority() + uri.getRawPath())) environment = candidate;
    }
    if (environment == null) return null;
    String fragment = blankless(uri.getRawFragment()), query = blankless(uri.getRawQuery());
    if ((fragment == null) == (query == null)) return new Callback.NoResult();
    Map<String, String> values = parameters(fragment != null ? fragment : query);
    if (values == null || values.size() != 2 || !validState(values.get("state"))) return new Callback.NoResult();
    if (values.containsKey("code")) return fragment != null ? new Callback.Code(environment.name, values.get("state"), values.get("code")) : new Callback.NoResult();
    String error = values.get("error");
    return error != null && RETURN_ERRORS.contains(error) ? new Callback.Error(environment.name, values.get("state"), error) : new Callback.NoResult();
  }

  private static String blankless(String value) { return value == null || value.isEmpty() ? null : value; }

  private static Map<String, String> parameters(String source) {
    Map<String, String> values = new LinkedHashMap<>();
    for (String part : source.split("&", -1)) {
      int equals = part.indexOf('=');
      if (equals <= 0) return null;
      String name = part.substring(0, equals), value = part.substring(equals + 1);
      if (!NAME.matcher(name).matches() || !VALUE.matcher(value).matches() || values.put(name, value) != null) return null;
    }
    return values;
  }

  public static boolean failureRoute(String scheme, String decodedHost, String decodedPath, List<String> hosts, String failurePath) {
    if (failurePath == null || scheme == null || decodedHost == null || !"https".equals(scheme.toLowerCase(Locale.ROOT)) || !failurePath.equals(decodedPath)) return false;
    for (String host : hosts) if (host.equalsIgnoreCase(decodedHost)) return true;
    return false;
  }

  public record CallbackFilter(boolean exported, boolean autoVerify, boolean viewBrowsable, Set<String> schemes, Set<String> hosts, Set<String> paths, boolean extraData) {}

  public static boolean callbackFilterAdmits(CallbackFilter f, String host, String path) {
    return f.exported() && f.autoVerify() && f.viewBrowsable() && !f.extraData()
      && f.schemes().equals(Set.of("https")) && f.hosts().equals(Set.of(host)) && f.paths().equals(Set.of(path));
  }

  public static boolean manifestHasCallback(List<CallbackFilter> filters, String host, String path) {
    for (CallbackFilter f : filters) if (callbackFilterAdmits(f, host, path)) return true;
    return false;
  }
}
