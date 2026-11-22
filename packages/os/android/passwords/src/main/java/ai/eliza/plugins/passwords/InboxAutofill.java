package ai.eliza.plugins.passwords;

import android.app.assist.AssistStructure;
import android.content.Context;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.service.autofill.Dataset;
import android.service.autofill.FillCallback;
import android.service.autofill.FillResponse;
import android.view.View;
import android.view.autofill.AutofillId;
import android.view.autofill.AutofillValue;
import java.util.UUID;
import java.util.function.Consumer;

public final class InboxAutofill {
  private static final String ORIGIN = "https://westvaleelectric.com";
  private static final String LEASE = "ai.eliza.inbox.fieldLease";
  private static final String CHALLENGE = "ai.eliza.inbox.challenge";
  static final String SCHEME = "eliza-inbox-autofill";
  private static final long TTL_MS = 120_000;
  private static final Handler MAIN = new Handler(Looper.getMainLooper());
  private static Host host;
  private static FieldGate fields;
  private static Selection pending;
  private InboxAutofill() {}

  public interface Host {
    void offer(Context context, String origin, String challenge, CancellationSignal cancelled,
        Consumer<Offer> completed);
  }
  public interface Offer {
    boolean current();
    void redeem(CancellationSignal cancelled, Consumer<AutofillValue> completed);
  }
  public interface FieldGate {
    boolean current(String fieldLease, String origin, String challenge, boolean visible);
  }
  public static synchronized void install(Host provider, FieldGate gate) {
    host = provider;
    fields = gate;
    pending = null;
  }
  private enum Stage { LOOKUP, OFFERED, SELECTED, DELIVERY }
  static final class Selection {
    final String lease, challenge, token = UUID.randomUUID().toString();
    final AutofillId field;
    final long expiresAt = SystemClock.elapsedRealtime() + TTL_MS;
    Stage stage = Stage.LOOKUP;
    Offer offer;
    Selection(String lease, String challenge, AutofillId field) {
      this.lease = lease;
      this.challenge = challenge;
      this.field = field;
    }
  }
  private static Selection target(Context context, AssistStructure structure) {
    if (structure == null || structure.getActivityComponent() == null
        || !context.getPackageName().equals(structure.getActivityComponent().getPackageName()))
      return null;
    Selection result = null;
    for (int i = 0; i < structure.getWindowNodeCount(); i++) {
      Selection match = find(structure.getWindowNodeAt(i).getRootViewNode(), 0);
      if (match == null)
        continue;
      if (result != null)
        throw new IllegalArgumentException("Ambiguous inbox target");
      result = match;
    }
    return result;
  }
  private static Selection find(AssistStructure.ViewNode node, int depth) {
    if (depth > 64)
      throw new IllegalArgumentException("Unsupported autofill structure");
    Bundle extras = node.getExtras();
    if (extras != null && extras.containsKey(LEASE)) {
      String lease = extras.getString(LEASE), challenge = extras.getString(CHALLENGE);
      String[] hints = node.getAutofillHints();
      if (lease == null || !lease.matches("[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}") || challenge == null
          || !challenge.matches("[0-9a-f]{32}")
          || !ORIGIN.equals(extras.getString("ai.eliza.autofill.fieldOrigin"))
          || node.getVisibility() != View.VISIBLE || !node.isFocused() || node.getAutofillId() == null
          || node.getAutofillType() != View.AUTOFILL_TYPE_TEXT || hints == null || hints.length != 1
          || !"one-time-code".equals(hints[0]))
        throw new IllegalArgumentException("Unverified inbox field");
      return new Selection(lease, challenge, node.getAutofillId());
    }
    Selection result = null;
    for (int i = 0; i < node.getChildCount(); i++) {
      Selection match = find(node.getChildAt(i), depth + 1);
      if (match == null)
        continue;
      if (result != null)
        throw new IllegalArgumentException("Ambiguous inbox target");
      result = match;
    }
    return result;
  }
  static boolean handle(
      Context context, AssistStructure structure, CancellationSignal cancel, FillCallback callback) {
    synchronized (InboxAutofill.class) {
      if (host == null || fields == null)
        return false;
    }
    Selection selection = target(context, structure);
    if (selection == null)
      return false;
    Host provider;
    synchronized (InboxAutofill.class) {
      pending = selection;
      provider = valid(selection, Stage.LOOKUP) ? host : null;
    }
    if (provider == null || cancel.isCanceled()) {
      cancel(selection);
      callback.onSuccess(null);
      return true;
    }
    MAIN.postDelayed(() -> cancel(selection), TTL_MS);
    CancellationSignal lookup = new CancellationSignal();
    cancel.setOnCancelListener(() -> {
      lookup.cancel();
      cancel(selection);
    });
    provider.offer(
        context.getApplicationContext(), ORIGIN, selection.challenge, lookup, offer -> MAIN.post(() -> {
          synchronized (InboxAutofill.class) {
            if (!valid(selection, Stage.LOOKUP) || cancel.isCanceled() || offer == null || !offer.current()) {
              if (!cancel.isCanceled())
                callback.onSuccess(null);
              return;
            }
            selection.offer = offer;
            selection.stage = Stage.OFFERED;
          }
          Dataset dataset = new Dataset
                                .Builder(ElizaPasswordAutofillService.presentation(
                                    context, context.getString(R.string.eliza_passwords_inbox_offer)))
                                .setValue(selection.field, null)
                                .setAuthentication(ElizaPasswordAutofillService.sender(
                                    context, InboxAutofillActivity.class, SCHEME, selection.token))
                                .build();
          callback.onSuccess(new FillResponse.Builder().addDataset(dataset).build());
        }));
    return true;
  }
  private static boolean valid(Selection s, Stage stage) {
    return s != null && pending == s && s.stage == stage && SystemClock.elapsedRealtime() < s.expiresAt
        && fields != null
        && fields.current(s.lease, ORIGIN, s.challenge, stage == Stage.LOOKUP || stage == Stage.DELIVERY);
  }
  static synchronized Selection select(String token) {
    if (!valid(pending, Stage.OFFERED) || !pending.token.equals(token) || !pending.offer.current())
      return null;
    pending.stage = Stage.SELECTED;
    return pending;
  }
  static synchronized boolean deliver(Selection s) {
    if (!valid(s, Stage.SELECTED) || !s.offer.current())
      return false;
    s.stage = Stage.DELIVERY;
    return true;
  }
  static synchronized void cancel(Selection s) {
    if (s == pending)
      pending = null;
  }
  public static synchronized boolean claimDelivery(String fieldLease, String origin, String challenge) {
    Selection s = pending;
    if (!valid(s, Stage.DELIVERY) || !ORIGIN.equals(origin) || !s.lease.equals(fieldLease)
        || !s.challenge.equals(challenge))
      return false;
    pending = null;
    return s.offer.current();
  }
}
