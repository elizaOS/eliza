// spec/os/signIn/browserReturn.md, "Story: Complete a browser sign-in only for the client that started it"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.signin.BrowserReturnPolicy.Callback;
import ai.eliza.plugins.signin.BrowserReturnPolicy.Owner;
import ai.eliza.plugins.signin.BrowserReturns.Ended;
import ai.eliza.plugins.signin.BrowserReturns.Handoff;
import ai.eliza.plugins.signin.CodeSignIn.Verified;
import ai.eliza.plugins.signin.SignInCustody.Proof;
import ai.eliza.plugins.signin.SignInCustody.Refused;
import ai.eliza.plugins.signin.SignInPolicy.Failure;
import ai.eliza.plugins.signin.SignInRegistration.Environment;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.verify.domain.DomainVerificationManager;
import android.content.pm.verify.domain.DomainVerificationUserState;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import com.getcapacitor.Plugin;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Supplier;
import org.json.JSONException;
import org.json.JSONObject;

public final class BrowserSignIn implements GoogleSignIn.Browser, BrowserReturns.Port {
  public interface Notices {
    void incomplete(String environment, String code);

    void signedIn(String environment, String credentialId);
  }

  private record Live(String requestId, GoogleSignIn.Returned returned) {}

  private static final String TAG = "ElizaSignIn";
  private static final long RETIRE_AFTER_MS = 5_000L;
  private static final int RETIRE_TRIES = 3;
  private static final Object PROCESS = new Object();
  private static final List<String> QUEUED = new ArrayList<>();
  private static BrowserSignIn current;
  private static Notices notices = new Notices() {
    @Override public void incomplete(String environment, String code) { Log.i(TAG, "A browser sign-in for " + environment + " did not complete: " + code); }
    @Override public void signedIn(String environment, String credentialId) { Log.i(TAG, "A browser sign-in for " + environment + " completed"); }
  };

  private final Context context;
  private final Supplier<Activity> activity;
  private final SignInRegistration registration;
  private final SignInCustody custody;
  private final CodeSignIn codes;
  private final ExecutorService worker = Executors.newSingleThreadExecutor();
  private final Handler main = new Handler(Looper.getMainLooper());
  private final Map<String, BrowserReturns> engines = new HashMap<>();
  private final Map<String, Live> live = new HashMap<>();

  private BrowserSignIn(Context context, Supplier<Activity> activity, SignInRegistration registration) {
    this.context = context.getApplicationContext();
    this.activity = activity;
    this.registration = registration;
    this.custody = DeviceCustody.custody(this.context, registration);
    this.codes = new CodeSignIn(CodeSignIn.CONNECTION, registration.clientId);
  }

  public static GoogleSignIn.Browser browser(Plugin plugin, SignInRegistration registration) {
    BrowserSignIn created = new BrowserSignIn(plugin.getContext(), plugin::getActivity, registration);
    List<String> waiting;
    synchronized (PROCESS) {
      current = created;
      waiting = new ArrayList<>(QUEUED);
      QUEUED.clear();
    }
    for (String url : waiting) created.deliver(url);
    return created;
  }

  public static void notices(Notices listener) {
    synchronized (PROCESS) { notices = listener; }
  }

  private static Notices notices() {
    synchronized (PROCESS) { return notices; }
  }

  public static void arrived(String url) {
    BrowserSignIn held;
    synchronized (PROCESS) {
      held = current;
      if (held == null) { QUEUED.add(url); return; }
    }
    held.deliver(url);
  }

  public static boolean claims(String url) {
    BrowserSignIn held;
    synchronized (PROCESS) { held = current; }
    return held != null && BrowserReturnPolicy.parseCallback(url, held.registration.environments()) != null;
  }

  public static void signedOut(Context context, SignInRegistration registration, BrowserReturnPolicy.CredentialAction kind) {
    BrowserSignIn held;
    synchronized (PROCESS) { held = current; }
    if (held != null) { for (Environment environment : registration.environments()) held.engine(environment).credentialActed(kind); return; }
    for (Environment environment : registration.environments()) {
      KeystoreSlot slot = slot(context, environment);
      try {
        String raw = slot.read();
        if (raw != null) slot.compareExchange(raw, null);
      } catch (Exception staleByGeneration) {
        Log.w(TAG, "A browser-return record outlives a credential action; its generation keeps it from being exchanged", staleByGeneration);
      }
    }
  }

  private static KeystoreSlot slot(Context context, Environment environment) {
    return new KeystoreSlot(context.getApplicationContext(), KeystoreSlot.BROWSER_RETURN + ":" + environment.name);
  }

  private synchronized BrowserReturns engine(Environment environment) {
    BrowserReturns known = engines.get(environment.name);
    if (known != null) return known;
    if (!(DeviceCustody.reader(context, environment.apiOrigin) instanceof DeviceCredentialStore store))
      throw new IllegalStateException("The device credential is not held by the device store");
    BrowserReturns created = new BrowserReturns(slot(context, environment), store, this);
    engines.put(environment.name, created);
    return created;
  }

  private void deliver(String url) {
    Callback callback = BrowserReturnPolicy.parseCallback(url, registration.environments());
    if (callback == null || callback instanceof Callback.NoResult) return;
    String name = callback instanceof Callback.Code code ? code.environment() : ((Callback.Error) callback).environment();
    worker.execute(() -> engine(registration.environment(name)).returned(callback));
  }

  @Override public void open(String requestId, Environment environment, SignInPolicy.Purpose purpose, GoogleSignIn.Returned returned) {
    worker.execute(() -> {
      String state = SignInPolicy.newState(), verifier = SignInPolicy.newVerifier();
      BrowserReturnPolicy.StartChecks checks = BrowserReturnPolicy.checks(registration, environment, state, verifier, appLinkVerified(environment));
      synchronized (live) { live.put(environment.name, new Live(requestId, returned)); }
      boolean started;
      try {
        started = engine(environment).start(environment.name, state, verifier, checks);
      } catch (BrowserReturns.StorageFailure unstored) {
        Log.e(TAG, "A browser sign-in could not keep its return record", unstored);
        ended(environment.name, Ended.STORAGE);
        return;
      }
      if (!started) { fail(environment.name, requestId, Failure.GOOGLE_UNAVAILABLE); return; }
      main.postDelayed(() -> worker.execute(() -> engine(environment).elapsed()), BrowserReturnPolicy.PENDING_LIFETIME_MS + 1);
      String url = BrowserReturnPolicy.authorizeUrl(registration.clientId, environment, state, verifier);
      main.post(() -> launch(environment, requestId, url));
    });
  }

  private void launch(Environment environment, String requestId, String url) {
    Activity host = activity.get();
    Intent view = new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE);
    try {
      if (host == null || host.isFinishing()) context.startActivity(view.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
      else host.startActivity(view);
    } catch (ActivityNotFoundException | SecurityException unavailable) {
      worker.execute(() -> { engine(environment).cancel(environment.name); fail(environment.name, requestId, Failure.GOOGLE_UNAVAILABLE); });
    }
  }

  @Override public void cancel(String requestId) {
    worker.execute(() -> {
      String name = null;
      synchronized (live) {
        for (Map.Entry<String, Live> entry : live.entrySet()) if (entry.getValue().requestId().equals(requestId)) name = entry.getKey();
        if (name != null) live.remove(name);
      }
      if (name != null) engine(registration.environment(name)).cancel(name);
    });
  }

  private boolean appLinkVerified(Environment environment) {
    PackageManager packages = context.getPackageManager();
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      try {
        DomainVerificationUserState user = context.getSystemService(DomainVerificationManager.class).getDomainVerificationUserState(context.getPackageName());
        Integer host = user == null ? null : user.getHostToStateMap().get(environment.appLinkHost);
        return user != null && user.isLinkHandlingAllowed() && host != null && host == DomainVerificationUserState.DOMAIN_STATE_VERIFIED;
      } catch (PackageManager.NameNotFoundException missing) {
        return false;
      }
    }
    Intent callback = new Intent(Intent.ACTION_VIEW, Uri.parse(environment.redirectUri)).addCategory(Intent.CATEGORY_BROWSABLE).setPackage(context.getPackageName());
    return packages.resolveActivity(callback, PackageManager.MATCH_DEFAULT_ONLY) != null;
  }

  private Live take(String client) {
    synchronized (live) { return live.remove(client); }
  }

  private void fail(String client, String requestId, Failure failure) {
    Live held;
    synchronized (live) {
      held = live.get(client);
      if (held == null || !held.requestId().equals(requestId)) return;
      live.remove(client);
    }
    held.returned().failed(failure);
  }

  @Override public void ended(String client, Ended why) {
    Live held = take(client);
    Failure failure = switch (why) {
      case EXPIRED -> Failure.EXPIRED;
      case STORAGE -> Failure.UNAVAILABLE;
      case SUPERSEDED, CANCELLED -> Failure.CANCELLED;
    };
    if (held != null) held.returned().failed(failure);
    else if (why == Ended.STORAGE) notices().incomplete(client, failure.wire);
    if (why == Ended.STORAGE) retire(client, RETIRE_TRIES);
  }

  private void retire(String client, int tries) {
    main.postDelayed(() -> worker.execute(() -> {
      BrowserReturns engine = engine(registration.environment(client));
      engine.retire();
      if (engine.state().retirement() == BrowserReturnPolicy.Retirement.UNCONFIRMED && tries > 1) retire(client, tries - 1);
    }), RETIRE_AFTER_MS);
  }

  @Override public void incomplete(String client) {
    notices().incomplete(client, Failure.REJECTED.wire);
  }

  @Override public void handed(Handoff handoff) {
    worker.execute(() -> exchange(handoff));
  }

  private static Failure returnFailure(String error) {
    return switch (error) {
      case "access_denied" -> Failure.CANCELLED;
      case "oauth_state_expired", "oauth_state_consumed" -> Failure.EXPIRED;
      case "oauth_provider_unavailable", "app_link_unverified" -> Failure.GOOGLE_UNAVAILABLE;
      default -> Failure.REJECTED;
    };
  }

  private Verified exchanged(Environment environment, Handoff handoff, String code) {
    JSONObject body = new JSONObject();
    try {
      body.put("code", code).put("redirectUri", environment.redirectUri).put("clientId", registration.clientId).put("codeVerifier", handoff.verifier());
    } catch (JSONException invalid) {
      throw new IllegalArgumentException(invalid);
    }
    try {
      return CodeSignIn.verified(CodeSignIn.CONNECTION.post(environment.apiOrigin + BrowserReturnPolicy.EXCHANGE, body, null), System.currentTimeMillis());
    } catch (IOException | RuntimeException unanswered) {
      return null;
    }
  }

  private void exchange(Handoff handoff) {
    Environment environment = registration.environment(handoff.client());
    BrowserReturns engine = engine(environment);
    Live held = handoff.owner() == Owner.LIVE ? take(handoff.client()) : null;
    if (handoff.callback() instanceof Callback.Error error) {
      engine.exchangeEnded(handoff.generation());
      finish(environment, held, returnFailure(error.error()));
      return;
    }
    Verified verified = exchanged(environment, handoff, ((Callback.Code) handoff.callback()).code());
    boolean current = engine.state().credential().generation() == handoff.generation();
    engine.exchangeEnded(handoff.generation());
    if (verified == null) {
      finish(environment, held, Failure.UNAVAILABLE);
      return;
    }
    if (!current) {
      if (verified instanceof Verified.SignedIn signedIn) codes.logout(environment, signedIn.session());
      finish(environment, held, Failure.CANCELLED);
      return;
    }
    if (held != null) { held.returned().answered(verified); return; }
    if (verified instanceof Verified.SignedIn signedIn) adopt(environment, handoff.generation(), signedIn);
    else notices().incomplete(environment.name, Failure.REJECTED.wire);
  }

  private void finish(Environment environment, Live held, Failure failure) {
    if (held == null) notices().incomplete(environment.name, failure.wire);
    else held.returned().failed(failure);
  }

  private void adopt(Environment environment, int generation, Verified.SignedIn signedIn) {
    int attempt = 0;
    Proof proof;
    try {
      attempt = custody.beginSignIn(environment);
      if (attempt != generation + 1) throw new Refused(Failure.CANCELLED);
      proof = custody.connect(attempt, environment, signedIn.session().accessToken());
    } catch (Refused refused) {
      if (attempt > 0) custody.signInEnded(environment, attempt);
      notices().incomplete(environment.name, refused.failure.wire);
      return;
    } finally {
      codes.logout(environment, signedIn.session());
    }
    try {
      notices().signedIn(environment.name, custody.redeem(attempt, environment, proof));
    } catch (Refused refused) {
      notices().incomplete(environment.name, refused.failure.wire);
    }
  }
}
