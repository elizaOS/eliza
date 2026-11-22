package ai.eliza.plugins.passwords;

import ai.eliza.plugins.securestore.nativeonly.PasswordFacets;
import ai.eliza.plugins.securestore.nativeonly.PasswordVaultStore;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import android.view.View;
import android.view.ViewTreeObserver;
import android.view.autofill.AutofillManager;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Vault management bridge for the host's own UI. Responses carry metadata only (ids, labels,
 * usernames, bindings, timestamps and status); no method resolves with a password. Passwords
 * may be supplied by the user's own typing (write-only) or generated natively. Reveal and copy
 * act natively and resolve with an acknowledgement. Rejections use fixed messages and codes and
 * never echo inputs.
 */
@CapacitorPlugin(name = "ElizaPasswords")
public class PasswordsPlugin extends Plugin {
  private static final SecureRandom RANDOM = new SecureRandom();
  private long unlockTicket;
  private View clipboardView;
  private final ViewTreeObserver.OnWindowFocusChangeListener clipboardFocus = focused -> {
    if (focused) SecretSurfaces.focused();
  };

  private PasswordVaultAccess access(PluginCall call) {
    try { return PasswordVaultAccess.get(getContext()); }
    catch (Exception unavailable) { call.reject("Saved passwords are unavailable", "unavailable"); return null; }
  }

  /** {@link #access} for a method that reaches the vault: the host's admission rule decides first. */
  private PasswordVaultAccess vault(PluginCall call) {
    if (!PasswordVaultAccess.admitted(getContext())) { call.reject("Saved passwords are not available here", "not-admitted"); return null; }
    PasswordVaultAccess access = access(call);
    if (access != null && access.deviceUnlockedCustody() && !access.activityCurrent(getActivity())) {
      fail(call, new PasswordVaultAccess.Locked()); return null;
    }
    return access;
  }

  private void fail(PluginCall call, Exception failure) {
    if (failure instanceof PasswordVaultStore.RevisionConflict) call.reject("This password changed. Reload it first", "conflict");
    else if (failure instanceof PasswordVaultAccess.NotAdmitted) call.reject("Saved passwords are not available here", "not-admitted");
    else if (failure instanceof PasswordVaultAccess.Locked) call.reject("Unlock saved passwords first", "locked");
    else if (failure instanceof PasswordVaultAccess.KeyInvalidated) call.reject("Saved passwords can no longer be decrypted on this device", "key-invalidated");
    else if (failure instanceof java.io.IOException && failure.getMessage() != null && SAFE_MESSAGES.contains(failure.getMessage())) call.reject(failure.getMessage(), "invalid");
    else call.reject("Saved passwords are unavailable", "unavailable");
  }

  /** Store validation messages are fixed strings; anything else is reported generically. */
  private static final List<String> SAFE_MESSAGES = java.util.Arrays.asList("Enter a name", "Enter a shorter username", "Enter a password",
    "Add at least one website or app", "Password no longer exists", "Password vault is full", "Use an HTTPS website address without a path", "Invalid binding",
    "Invalid app package", "Invalid app signing certificate", "Saved passwords are not damaged");

  @PluginMethod public void status(PluginCall call) {
    PasswordVaultAccess access = access(call); if (access == null) return;
    JSObject result = new JSObject();
    android.app.KeyguardManager keyguard = getContext().getSystemService(android.app.KeyguardManager.class);
    boolean deviceCustody = access.deviceUnlockedCustody();
    boolean secure = keyguard != null && keyguard.isDeviceSecure();
    boolean ownerForeground = deviceCustody && access.activityCurrent(getActivity()) && access.ownerForeground();
    result.put("available", deviceCustody ? ownerForeground : secure);
    if (deviceCustody) {
      result.put("custody", "device-unlocked");
      String reason = access.activityCurrent(getActivity()) ? access.blockedDeviceReason() : "device-locked";
      if (reason != null) result.put("reason", reason);
    } else if (!secure) result.put("reason", "no-screen-lock");
    long remaining = access.remainingMillis();
    result.put("locked", deviceCustody ? !ownerForeground || access.needsLegacyAuthorization() : remaining <= 0);
    result.put("unlockRemainingMs", deviceCustody ? JSObject.NULL : remaining);
    if (!deviceCustody) {
      result.put("unlockSeconds", access.config.unlockSeconds);
      result.put("biometric", access.config.biometric);
    }
    JSObject autofill = new JSObject();
    autofill.put("supported", JSObject.NULL);
    autofill.put("selected", "unknown");
    try {
      AutofillManager manager = getContext().getSystemService(AutofillManager.class);
      if (manager != null) {
        autofill.put("supported", manager.isAutofillSupported());
        ComponentName service = manager.getAutofillServiceComponentName();
        autofill.put("selected", service == null ? "none" : getContext().getPackageName().equals(service.getPackageName()) ? "this-app" : "other");
      }
    } catch (RuntimeException unavailable) { /* Remains unknown; never inferred. */ }
    result.put("autofill", autofill);
    call.resolve(result);
  }

  @PluginMethod public void unlock(PluginCall call) {
    PasswordVaultAccess access = vault(call); if (access == null) return;
    Activity activity = getActivity();
    if (activity == null) { call.reject("Saved passwords are unavailable", "unavailable"); return; }
    activity.runOnUiThread(() -> PasswordUnlock.prompt(activity, new PasswordUnlock.Result() {
      @Override public void unlocked(long ticket) { unlockTicket = ticket; JSObject result = new JSObject(); result.put("unlocked", true); result.put("unlockRemainingMs", access.deviceUnlockedCustody() ? JSObject.NULL : access.remainingMillis()); call.resolve(result); }
      @Override public void failed(String code) { call.reject("cancelled".equals(code) ? "Unlock was cancelled" : "no-screen-lock".equals(code) ? "Set a screen lock to use saved passwords" : "migration-unavailable".equals(code) ? "Your old saved passwords need their original Android authorization" : "Unlock is unavailable", code); }
    }));
  }

  @PluginMethod public void lock(PluginCall call) {
    PasswordVaultAccess access = access(call); if (access == null) return;
    if (!access.deviceUnlockedCustody() || (access.activityCurrent(getActivity()) && !PasswordSurfaces.visible())) {
      access.lock();
      PasswordVaultAccess.closeSurfaces();
    }
    JSObject result = new JSObject(); result.put("locked", true); call.resolve(result);
  }

  @PluginMethod public void list(PluginCall call) {
    PasswordVaultAccess access = vault(call); if (access == null) return;
    try {
      JSONArray entries = access.use(PasswordVaultStore::entries);
      JSArray out = new JSArray();
      for (int i = 0; i < entries.length(); i++) out.put(summary(entries.getJSONObject(i)));
      JSObject result = new JSObject(); result.put("entries", out); call.resolve(result);
    } catch (Exception failure) { fail(call, failure); }
  }

  /** Allowlisted metadata only; built field by field so a stored secret can never be copied out. */
  private JSObject summary(JSONObject entry) throws Exception {
    JSObject item = new JSObject();
    item.put("id", entry.getString("id"));
    item.put("label", entry.getString("label"));
    item.put("username", entry.getString("username"));
    item.put("updatedAt", entry.optLong("updatedAt", 0));
    item.put("revision", entry.optLong("revision", 0));
    JSArray bindings = new JSArray();
    for (String facet : PasswordVaultStore.bindings(entry)) {
      JSObject binding = new JSObject();
      binding.put("kind", PasswordFacets.isAndroid(facet) ? "android" : "web");
      binding.put("facet", facet);
      binding.put("display", PasswordSheet.bindingLabel(getContext(), facet));
      bindings.put(binding);
    }
    item.put("bindings", bindings);
    return item;
  }

  @PluginMethod public void save(PluginCall call) {
    PasswordVaultAccess access = vault(call); if (access == null) return;
    if (!access.config.bridgeAcceptsSecrets && !PasswordEditorPolicy.metadataOnly(call.getData().keys(), call.getData().opt("id"))) {
      call.reject("Passwords are entered only in the protected form", "invalid"); return;
    }
    try {
      String id = call.getString("id"), label = call.getString("label", ""), username = call.getString("username", "");
      String password = call.getString("password");
      JSObject generate = call.getObject("generate");
      if (password != null && generate != null) { call.reject("Choose a typed or generated password", "invalid"); return; }
      List<String> requested = new ArrayList<>();
      JSArray websites = call.getArray("websites", new JSArray());
      for (int i = 0; i < websites.length(); i++) requested.add(PasswordFacets.web(websites.getString(i)));
      JSArray keep = call.getArray("keepBindings", new JSArray());
      String generated = generate == null ? null : PasswordGenerator.generate(new PasswordGenerator.Options(
        generate.getInteger("length", PasswordGenerator.DEFAULT_LENGTH), generate.getBoolean("lowercase", true), generate.getBoolean("uppercase", true),
        generate.getBoolean("digits", true), generate.getBoolean("symbols", true)), RANDOM);
      String saved = access.use(store -> {
        LinkedHashSet<String> bindings = new LinkedHashSet<>();
        List<String> existing = new ArrayList<>();
        if (id != null) existing = PasswordVaultStore.bindings(store.get(id));
        for (int i = 0; i < keep.length(); i++) {
          String facet = PasswordFacets.normalize(keep.getString(i));
          // App bindings are created only by a verified save capture; the UI can keep or drop
          // them but never mint one for an arbitrary package.
          if (PasswordFacets.isAndroid(facet) && !existing.contains(facet)) throw new java.io.IOException("Invalid binding");
          bindings.add(facet);
        }
        bindings.addAll(requested);
        return store.saveEntry(id, label, username, new ArrayList<>(bindings), generated != null ? generated : password);
      });
      JSObject result = new JSObject(); result.put("id", saved);
      if (generated != null) { result.put("generated", true); result.put("length", generated.length()); }
      call.resolve(result);
    } catch (IllegalArgumentException invalid) {
      call.reject("Choose a length from 8 to 128 with at least one character type", "invalid");
    } catch (Exception failure) { fail(call, failure); }
  }

  /**
   * Native-only create or edit: neither draft fields nor generated values cross the bridge. An
   * edit names one entry at one revision and resolves with only the id and new revision.
   */
  @PluginMethod public void openEditor(PluginCall call) {
    PasswordEditorPolicy.Request request;
    try { request = PasswordEditorPolicy.admit(call.getData().keys(), call.getData().opt("entryId"), call.getData().opt("expectedRevision")); }
    catch (IllegalArgumentException invalid) { call.reject("Editor does not accept draft fields", "invalid"); return; }
    PasswordVaultAccess access = vault(call); if (access == null) return;
    Activity activity = getActivity();
    if (activity == null) { call.reject("Saved passwords are unavailable", "unavailable"); return; }
    long ticket = access.ticket();
    activity.runOnUiThread(() -> {
      try {
        PasswordEditor.open(activity, access, ticket, request, new PasswordEditor.Result() {
          public void saved(String id, long revision) { JSObject result = new JSObject(); result.put("status", "saved"); result.put("id", id); result.put("revision", revision); call.resolve(result); }
          public void cancelled() { JSObject result = new JSObject(); result.put("status", "cancelled"); call.resolve(result); }
        });
      } catch (PasswordEditor.Busy busy) { call.reject("Finish the current editor first", "busy"); }
      catch (Exception failure) { fail(call, failure); }
    });
  }

  private static Long expectedRevision(PluginCall call) {
    if (!call.getData().has("expectedRevision")) return null;
    Object value = call.getData().opt("expectedRevision");
    if (value instanceof Integer || value instanceof Long) {
      long revision = ((Number) value).longValue();
      if (revision >= 0 && revision <= 9_007_199_254_740_991L) return revision;
    }
    throw new IllegalArgumentException("Invalid revision");
  }

  @PluginMethod public void remove(PluginCall call) {
    PasswordVaultAccess access = vault(call); if (access == null) return;
    String id = call.getString("id");
    if (id == null) { call.reject("Choose a saved password", "invalid"); return; }
    try {
      Long revision = expectedRevision(call);
      access.useForOwner(getContext(), access.ticket(), store -> { store.removeExisting(id, revision); return true; });
      JSObject result = new JSObject(); result.put("removed", true); call.resolve(result);
    } catch (IllegalArgumentException invalid) { call.reject("Invalid revision", "invalid"); }
    catch (Exception failure) { fail(call, failure); }
  }

  /** Deletes the vault only when its key is lost or invalidated (see PasswordVaultStore). */
  @PluginMethod public void reset(PluginCall call) {
    PasswordVaultAccess access = vault(call); if (access == null) return;
    long ticket = access.ticket();
    Runnable reset = () -> {
      try {
        if (!access.unlocked(ticket)) throw new PasswordVaultAccess.Locked();
        access.resetUnrecoverable();
        JSObject result = new JSObject(); result.put("reset", true); call.resolve(result);
      } catch (Exception failure) { fail(call, failure); }
    };
    if (!access.deviceUnlockedCustody()) { reset.run(); return; }
    Activity activity = getActivity();
    if (activity == null) { fail(call, new PasswordVaultAccess.Locked()); return; }
    activity.runOnUiThread(() -> {
      if (!access.unlocked(ticket) || !activity.hasWindowFocus()) { fail(call, new PasswordVaultAccess.Locked()); return; }
      if (!SecretSurfaces.confirm(activity, R.string.eliza_passwords_reset_confirm, reset,
          () -> call.reject("Password reset cancelled", "cancelled"))) call.reject("Password action unavailable", "busy");
    });
  }

  @PluginMethod public void reveal(PluginCall call) { secret(call, true); }
  @PluginMethod public void copy(PluginCall call) { secret(call, false); }

  private void secret(PluginCall call, boolean reveal) {
    PasswordVaultAccess access = vault(call); if (access == null) return;
    String id = call.getString("id");
    Activity activity = getActivity();
    if (id == null || activity == null) { call.reject("Choose a saved password", "invalid"); return; }
    try {
      long ticket = access.ticket();
      Long revision = expectedRevision(call);
      Runnable deliver = () -> {
        try {
          if (activity.isFinishing() || activity.isDestroyed() || (access.deviceUnlockedCustody() ? !access.activityCurrent(activity) : !activity.hasWindowFocus())) throw new PasswordVaultAccess.Locked();
          JSObject result = new JSObject();
          access.useForOwner(activity, ticket, store -> store.useRecord(id, revision, record -> {
            String value = record.getString("password");
            if (reveal) {
              String label = record.optString("label", record.optString("origin", ""));
              SecretSurfaces.revealOwned(activity, label, value,
                () -> access.unlocked(ticket) && PasswordVaultAccess.admitted(activity));
              result.put("shown", true);
              result.put("hidesAfterMs", SecretSurfaces.REVEAL_MILLIS);
            } else {
              SecretSurfaces.copy(activity, value);
              result.put("copied", true);
              result.put("clearsAfterMs", SecretSurfaces.CLIPBOARD_MILLIS);
            }
            return true;
          }));
          call.resolve(result);
        } catch (Exception failure) { fail(call, failure); }
      };
      activity.runOnUiThread(() -> {
        if (!access.deviceUnlockedCustody()) { deliver.run(); return; }
        if (!access.unlocked(ticket) || !activity.hasWindowFocus()) { fail(call, new PasswordVaultAccess.Locked()); return; }
        int title = reveal ? R.string.eliza_passwords_reveal_confirm : R.string.eliza_passwords_copy_confirm;
        if (!SecretSurfaces.confirm(activity, title, deliver, () -> call.reject("Password action cancelled", "cancelled")))
          call.reject("Password action unavailable", "busy");
      });
    } catch (IllegalArgumentException invalid) { call.reject("Invalid revision", "invalid"); }
    catch (Exception failure) { fail(call, failure); }
  }

  /** Android's own confirmation selects the provider; nothing is set or inferred here. */
  @PluginMethod public void openAutofillSettings(PluginCall call) {
    Activity activity = getActivity();
    JSObject result = new JSObject();
    try {
      activity.startActivity(new Intent(Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE, Uri.parse("package:" + getContext().getPackageName())));
      result.put("status", "opened"); result.put("destination", "autofill-picker");
    } catch (ActivityNotFoundException | SecurityException missing) {
      try { activity.startActivity(new Intent(Settings.ACTION_SETTINGS)); result.put("status", "opened"); result.put("destination", "system-settings"); }
      catch (RuntimeException unavailable) { call.reject("Android settings are unavailable", "unavailable"); return; }
    }
    call.resolve(result);
  }

  @Override protected void handleOnStop() {
    Activity activity = getActivity();
    super.handleOnStop();
    stopWatchingClipboardFocus();
    try {
      PasswordVaultAccess access = PasswordVaultAccess.get(getContext());
      // The device-credential screen stops the host while an unlock is pending; keep that one.
      if (access.deviceUnlockedCustody()) return;
      if (!access.pending()) access.lock(unlockTicket);
    } catch (Exception ignored) { /* Nothing to lock. */ }
    PasswordEditor.dismiss(activity);
    SecretSurfaces.dismiss(activity);
  }

  @Override protected void handleOnResume() {
    super.handleOnResume();
    Activity activity = getActivity();
    if (activity == null) return;
    stopWatchingClipboardFocus();
    clipboardView = activity.getWindow().getDecorView();
    clipboardView.getViewTreeObserver().addOnWindowFocusChangeListener(clipboardFocus);
    if (activity.hasWindowFocus()) SecretSurfaces.focused();
  }

  private void stopWatchingClipboardFocus() {
    if (clipboardView == null) return;
    ViewTreeObserver observer = clipboardView.getViewTreeObserver();
    if (observer.isAlive()) observer.removeOnWindowFocusChangeListener(clipboardFocus);
    clipboardView = null;
  }

  @Override protected void handleOnDestroy() {
    Activity activity = getActivity();
    stopWatchingClipboardFocus();
    try {
      PasswordVaultAccess access = PasswordVaultAccess.get(getContext());
      if (!access.deviceUnlockedCustody()) access.lock(unlockTicket);
    }
    catch (Exception ignored) { /* Nothing to lock. */ }
    PasswordEditor.dismiss(activity);
    SecretSurfaces.dismiss(activity);
    super.handleOnDestroy();
  }
}
