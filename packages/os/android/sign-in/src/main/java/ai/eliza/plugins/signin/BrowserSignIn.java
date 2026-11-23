// spec/os/signIn/browserReturn.md, "Story: Complete a browser sign-in only for the client that started it"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.signin.BrowserReturnPolicy.Callback;
import ai.eliza.plugins.signin.BrowserReturnPolicy.Owner;
import ai.eliza.plugins.signin.BrowserReturns.Ended;
import ai.eliza.plugins.signin.BrowserReturns.Handoff;
import ai.eliza.plugins.signin.BrowserReturns.Purpose;
import ai.eliza.plugins.signin.BrowserReturns.Reservation;
import ai.eliza.plugins.signin.CodeSignIn.Checked;
import ai.eliza.plugins.signin.SignInPolicy.CloudReply;
import ai.eliza.plugins.signin.SignInCustody.Proof;
import ai.eliza.plugins.signin.SignInCustody.Refused;
import ai.eliza.plugins.signin.SignInPolicy.Failure;
import ai.eliza.plugins.signin.SignInRegistration.Environment;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
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

  private record Live(int attempt, Reservation reservation, GoogleSignIn.Returned returned) {}

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

  private BrowserSignIn(Context context, Supplier<Activity> activity, SignInRegistration registration, SignInCustody custody) {
    this.context = context.getApplicationContext();
    this.activity = activity;
    this.registration = registration;
    this.custody = custody;
    this.codes = new CodeSignIn(CodeSignIn.CONNECTION, registration.clientId);
  }

  public static GoogleSignIn.Browser browser(Plugin plugin, SignInRegistration registration, SignInCustody custody) {
    BrowserSignIn created = new BrowserSignIn(plugin.getContext(), plugin::getActivity, registration, custody);
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
      KeystoreSlot slot = slot(context, registration, environment);
      try {
        String raw = slot.read();
        if (raw != null) slot.compareExchange(raw, null);
      } catch (Exception staleByGeneration) {
        Log.w(TAG, "A browser-return record outlives a credential action; its generation keeps it from being exchanged", staleByGeneration);
      }
    }
  }

  private static KeystoreSlot slot(Context context, SignInRegistration registration, Environment environment) {
    String binding = String.join("\n", registration.clientId, environment.name, environment.apiOrigin, environment.redirectUri);
    return new KeystoreSlot(context.getApplicationContext(), KeystoreSlot.BROWSER_RETURN + ":" + DeviceCredentialStore.authorityDigest(binding));
  }

  private synchronized BrowserReturns engine(Environment environment) {
    BrowserReturns known = engines.get(environment.name);
    if (known != null) return known;
    if (!(DeviceCustody.reader(context, environment.apiOrigin) instanceof DeviceCredentialStore store))
      throw new IllegalStateException("The device credential is not held by the device store");
    BrowserReturns created = new BrowserReturns(slot(context, registration, environment), store, this);
    engines.put(environment.name, created);
    return created;
  }

  private void deliver(String url) {
    Callback callback = BrowserReturnPolicy.parseCallback(url, registration.environments());
    if (callback == null || callback instanceof Callback.NoResult) return;
    String name = callback instanceof Callback.Code code ? code.environment() : ((Callback.Error) callback).environment();
    worker.execute(() -> engine(registration.environment(name)).returned(callback));
  }

  @Override public void open(int attempt, Environment environment, boolean reauthenticate, GoogleSignIn.Returned returned) {
    worker.execute(() -> {
      String state = SignInPolicy.newState(), verifier = SignInPolicy.newVerifier();
      BrowserReturnPolicy.StartChecks checks = BrowserReturnPolicy.checks(registration, environment, state, verifier, appLinkVerified(context, environment));
      BrowserReturns engine = engine(environment);
      Reservation reserved;
      try {
        reserved = engine.start(environment.name, state, verifier, reauthenticate ? Purpose.REAUTHENTICATE : Purpose.SIGN_IN, checks);
      } catch (BrowserReturns.StorageFailure | DeviceCredentialStore.StorageFailure unstored) {
        returned.refused(Failure.UNAVAILABLE);
        retire(environment.name, RETIRE_TRIES);
        return;
      }
      if (reserved == null) { returned.refused(Failure.GOOGLE_UNAVAILABLE); return; }
      Live opened = new Live(attempt, reserved, returned);
      synchronized (live) { live.put(environment.name, opened); }
      var pending = engine.state().record();
      if (pending == null || pending.generation() != reserved.generation()) {
        Live retired = take(environment.name, reserved.generation());
        if (retired != null) retired.returned().refused(Failure.CANCELLED);
        return;
      }
      main.postDelayed(() -> worker.execute(engine::elapsed), BrowserReturnPolicy.PENDING_LIFETIME_MS + 1);
      String url = BrowserReturnPolicy.authorizeUrl(registration.clientId, environment, state, verifier);
      main.post(() -> launch(environment, opened, url));
    });
  }

  private void launch(Environment environment, Live opened, String url) {
    synchronized (live) {
      if (live.get(environment.name) != opened) return;
    }
    Activity host = activity.get();
    String browser = externalBrowser(context, url);
    if (browser == null) { unlaunched(environment, opened); return; }
    Intent view = new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE).setPackage(browser);
    try {
      if (host == null || host.isFinishing()) context.startActivity(view.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
      else host.startActivity(view);
    } catch (ActivityNotFoundException | SecurityException unavailable) {
      unlaunched(environment, opened);
    }
  }

  private void unlaunched(Environment environment, Live opened) {
    worker.execute(() -> {
      Live failed = take(environment.name, opened.reservation().generation());
      engine(environment).cancel(opened.reservation());
      if (failed != null) failed.returned().refused(Failure.GOOGLE_UNAVAILABLE);
    });
  }

  @Override public void cancel(int attempt) {
    worker.execute(() -> {
      Reservation reserved = null;
      synchronized (live) {
        var pending = live.values().iterator();
        while (pending.hasNext()) {
          Live held = pending.next();
          if (held.attempt() != attempt) continue;
          reserved = held.reservation();
          pending.remove();
          break;
        }
      }
      if (reserved != null) engine(registration.environment(reserved.client())).cancel(reserved);
    });
  }

  static String externalBrowser(Context context, String url) {
    PackageManager packages = context.getPackageManager();
    Intent view = new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE);
    ResolveInfo chosen = packages.resolveActivity(view, PackageManager.MATCH_DEFAULT_ONLY);
    List<String> handlers = new ArrayList<>();
    for (ResolveInfo handler : packages.queryIntentActivities(view, PackageManager.MATCH_DEFAULT_ONLY)) {
      if (handler.activityInfo != null) handlers.add(handler.activityInfo.packageName);
    }
    String browser = ReadinessPolicy.browserToOpen(handlers, chosen == null || chosen.activityInfo == null ? "" : chosen.activityInfo.packageName,
      context.getPackageName());
    return browser.isEmpty() ? null : browser;
  }

  static boolean appLinkVerified(Context context, Environment environment) {
    PackageManager packages = context.getPackageManager();
    Intent callback = new Intent(Intent.ACTION_VIEW, Uri.parse(environment.redirectUri)).addCategory(Intent.CATEGORY_BROWSABLE);
    var handler = packages.resolveActivity(callback, PackageManager.MATCH_DEFAULT_ONLY);
    if (handler == null || handler.activityInfo == null || !handler.activityInfo.enabled || !handler.activityInfo.exported ||
        !handler.activityInfo.packageName.equals(context.getPackageName()) ||
        !handler.activityInfo.name.equals(SignInCallbackActivity.class.getName())) return false;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      try {
        DomainVerificationManager domains = context.getSystemService(DomainVerificationManager.class);
        DomainVerificationUserState user = domains == null ? null : domains.getDomainVerificationUserState(context.getPackageName());
        Integer host = user == null ? null : user.getHostToStateMap().get(environment.appLinkHost);
        return user != null && user.isLinkHandlingAllowed() && host != null && host == DomainVerificationUserState.DOMAIN_STATE_VERIFIED;
      } catch (PackageManager.NameNotFoundException missing) {
        return false;
      }
    }
    return true;
  }

  private Live take(String client, int generation) {
    synchronized (live) {
      Live held = live.get(client);
      if (held == null || held.reservation().generation() != generation) return null;
      live.remove(client);
      return held;
    }
  }

  @Override public void ended(String client, int generation, Ended why) {
    Live held = take(client, generation);
    Failure failure = switch (why) {
      case EXPIRED -> Failure.EXPIRED;
      case STORAGE -> Failure.UNAVAILABLE;
      case SUPERSEDED, CANCELLED -> Failure.CANCELLED;
    };
    if (held != null) held.returned().refused(failure);
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

  private Checked exchanged(Environment environment, Handoff handoff, String code) {
    JSONObject body = new JSONObject();
    try {
      body.put("code", code).put("redirectUri", environment.redirectUri).put("clientId", registration.clientId).put("codeVerifier", handoff.verifier());
    } catch (JSONException invalid) {
      throw new IllegalArgumentException(invalid);
    }
    try {
      return CodeSignIn.checked(CodeSignIn.CONNECTION.post(environment.apiOrigin + BrowserReturnPolicy.EXCHANGE, body, null), System.currentTimeMillis());
    } catch (IOException | RuntimeException unanswered) {
      return new Checked.NotChecked(new CloudReply.Unanswered());
    }
  }

  private void exchange(Handoff handoff) {
    Environment environment = registration.environment(handoff.client());
    BrowserReturns engine = engine(environment);
    int generation = handoff.generation();
    Live held = handoff.owner() == Owner.LIVE ? take(handoff.client(), generation) : null;
    if (handoff.owner() == Owner.LIVE && held == null) {
      engine.exchangeEnded(generation);
      return;
    }
    if (!engine.mayExchange(handoff)) {
      engine.exchangeEnded(generation);
      finish(environment, held, Failure.CANCELLED);
      return;
    }
    if (handoff.callback() instanceof Callback.Error error) {
      engine.exchangeEnded(generation);
      finish(environment, held, returnFailure(error.error()));
      return;
    }
    Checked answer = exchanged(environment, handoff, ((Callback.Code) handoff.callback()).code());
    if (!engine.takeExchange(handoff)) {
      engine.exchangeEnded(generation);
      if (answer instanceof Checked.SessionIssued issued) codes.logout(environment, issued.session());
      finish(environment, held, Failure.CANCELLED);
      return;
    }
    if (held != null) {
      if (handoff.purpose() == Purpose.REAUTHENTICATE) {
        custody.signInEnded(environment, generation);
        held.returned().exchanged(0, answer);
      } else {
        held.returned().exchanged(generation, answer);
      }
    } else if (answer instanceof Checked.SessionIssued issued) {
      adopt(environment, generation, issued);
    } else {
      custody.signInEnded(environment, generation);
      notices().incomplete(environment.name, Failure.REJECTED.wire);
    }
  }

  private void finish(Environment environment, Live held, Failure failure) {
    if (held == null) notices().incomplete(environment.name, failure.wire);
    else held.returned().refused(failure);
  }

  private void adopt(Environment environment, int generation, Checked.SessionIssued issued) {
    try {
      Proof proof;
      try { proof = custody.connect(generation, environment, issued.session().accessToken()); }
      finally { codes.logout(environment, issued.session()); }
      notices().signedIn(environment.name, custody.redeem(generation, environment, proof));
    } catch (Refused refused) {
      notices().incomplete(environment.name, refused.failure.wire);
    } finally {
      custody.signInEnded(environment, generation);
    }
  }
}
