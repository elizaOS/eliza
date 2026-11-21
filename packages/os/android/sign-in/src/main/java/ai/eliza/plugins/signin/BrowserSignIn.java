// spec/os/signIn/browserReturn.md, "Story: Complete a browser sign-in only for the client that started it"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.signin.BrowserReturnPolicy.Callback;
import ai.eliza.plugins.signin.BrowserReturnPolicy.Owner;
import ai.eliza.plugins.signin.BrowserReturns.Ended;
import ai.eliza.plugins.signin.BrowserReturns.Handoff;
import ai.eliza.plugins.signin.CodeSignIn.Checked;
import ai.eliza.plugins.signin.CredentialPolicy.Reason;
import ai.eliza.plugins.signin.SignInCustody.Proof;
import ai.eliza.plugins.signin.SignInCustody.Refused;
import ai.eliza.plugins.signin.SignInCustody.Session;
import ai.eliza.plugins.signin.SignInPolicy.CloudReply;
import ai.eliza.plugins.signin.SignInPolicy.Failure;
import ai.eliza.plugins.signin.SignInPolicy.RefusalCode;
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
import org.json.JSONObject;

public final class BrowserSignIn implements GoogleSignIn.Browser, BrowserReturns.Port {
  public interface Notices {
    void incomplete(String environment, String code);

    void signedIn(String environment, String credentialId);
  }

  private record Live(int attempt, boolean reauthenticate, GoogleSignIn.Returned returned) {}

  private static final CloudReply EXPIRED = new CloudReply.Refused(RefusalCode.AUTHENTICATION_REQUIRED, Reason.CREDENTIAL_EXPIRED);
  private static final CloudReply GOOGLE_UNAVAILABLE = new CloudReply.Refused(RefusalCode.PROVIDER_UNAVAILABLE, Reason.NO_REASON);
  private static final CloudReply REJECTED = new CloudReply.Refused(RefusalCode.ACCESS_DENIED, Reason.NO_REASON);
  private static final CloudReply UNANSWERED = new CloudReply.Unanswered();

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

  @Override public void open(int attempt, Environment environment, boolean reauthenticate, GoogleSignIn.Returned returned) {
    worker.execute(() -> {
      String state = SignInPolicy.newState(), verifier = SignInPolicy.newVerifier();
      BrowserReturnPolicy.StartChecks checks = BrowserReturnPolicy.checks(registration, environment, state, verifier, appLinkVerified(environment));
      synchronized (live) { live.put(environment.name, new Live(attempt, reauthenticate, returned)); }
      boolean started;
      try {
        started = engine(environment).start(environment.name, state, verifier, checks);
      } catch (BrowserReturns.StorageFailure unstored) {
        Log.e(TAG, "A browser sign-in could not keep its return record", unstored);
        fail(environment.name, attempt, UNANSWERED);
        return;
      }
      if (!started) { fail(environment.name, attempt, GOOGLE_UNAVAILABLE); return; }
      main.postDelayed(() -> worker.execute(() -> engine(environment).elapsed()), BrowserReturnPolicy.PENDING_LIFETIME_MS + 1);
      String url = BrowserReturnPolicy.authorizeUrl(registration.clientId, environment, state, verifier);
      main.post(() -> launch(environment, attempt, url));
    });
  }

  private void launch(Environment environment, int attempt, String url) {
    Activity host = activity.get();
    Intent view = new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE);
    try {
      if (host == null || host.isFinishing()) context.startActivity(view.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
      else host.startActivity(view);
    } catch (ActivityNotFoundException | SecurityException unavailable) {
      worker.execute(() -> { fail(environment.name, attempt, GOOGLE_UNAVAILABLE); engine(environment).cancel(environment.name); });
    }
  }

  @Override public void cancel(int attempt) {
    worker.execute(() -> {
      String name = null;
      synchronized (live) {
        for (Map.Entry<String, Live> entry : live.entrySet()) if (entry.getValue().attempt() == attempt) name = entry.getKey();
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

  private static void refuse(Live held, CloudReply reply) {
    held.returned().exchanged(0, new Checked.NotChecked(reply));
  }

  private static String wire(CloudReply reply) {
    return reply instanceof CloudReply.Refused refused ? SignInPolicy.failureOf(false, refused.code(), refused.reason()).wire : Failure.UNAVAILABLE.wire;
  }

  private void fail(String client, int attempt, CloudReply reply) {
    Live held;
    synchronized (live) {
      held = live.get(client);
      if (held == null || held.attempt() != attempt) return;
      live.remove(client);
    }
    refuse(held, reply);
  }

  @Override public void ended(String client, Ended why) {
    Live held = take(client);
    CloudReply reply = switch (why) {
      case EXPIRED -> EXPIRED;
      case STORAGE -> UNANSWERED;
      case SUPERSEDED, CANCELLED -> REJECTED;
    };
    if (held != null) refuse(held, reply);
    else if (why == Ended.STORAGE) notices().incomplete(client, wire(reply));
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

  private static CloudReply returnReply(String error) {
    return switch (error) {
      case "oauth_state_expired", "oauth_state_consumed" -> EXPIRED;
      case "oauth_provider_unavailable", "app_link_unverified" -> GOOGLE_UNAVAILABLE;
      default -> REJECTED;
    };
  }

  private Checked exchanged(Environment environment, Handoff handoff) {
    if (handoff.callback() instanceof Callback.Error error) return new Checked.NotChecked(returnReply(error.error()));
    String code = ((Callback.Code) handoff.callback()).code();
    JSONObject body = CodeSignIn.json("code", code, "redirectUri", environment.redirectUri, "clientId", registration.clientId, "codeVerifier", handoff.verifier());
    try {
      return CodeSignIn.checked(CodeSignIn.CONNECTION.post(environment.apiOrigin + BrowserReturnPolicy.EXCHANGE, body, null), System.currentTimeMillis());
    } catch (IOException | RuntimeException unanswered) {
      return new Checked.NotChecked(UNANSWERED);
    }
  }

  private void exchange(Handoff handoff) {
    Environment environment = registration.environment(handoff.client());
    BrowserReturns engine = engine(environment);
    int generation = handoff.generation();
    Live held = handoff.owner() == Owner.LIVE ? take(handoff.client()) : null;
    if (handoff.owner() == Owner.LIVE && held == null) { engine.exchangeEnded(generation); return; }
    Checked checked = exchanged(environment, handoff);
    if (held != null) {
      boolean keepsReservation = !held.reauthenticate() && checked instanceof Checked.SessionIssued;
      if (!keepsReservation) engine.exchangeEnded(generation);
      held.returned().exchanged(keepsReservation ? generation : 0, checked);
      return;
    }
    if (checked instanceof Checked.SessionIssued issued) { adopt(environment, engine, generation, issued.session()); return; }
    engine.exchangeEnded(generation);
    notices().incomplete(environment.name, checked instanceof Checked.NotChecked refused ? wire(refused.reply()) : Failure.REJECTED.wire);
  }

  private void adopt(Environment environment, BrowserReturns engine, int generation, Session session) {
    try {
      Proof proof;
      try { proof = custody.connect(generation, environment, session.accessToken()); }
      finally { codes.logout(environment, session); }
      notices().signedIn(environment.name, custody.redeem(generation, environment, proof));
    } catch (Refused refused) {
      engine.exchangeEnded(generation);
      notices().incomplete(environment.name, refused.failure.wire);
    }
  }
}
