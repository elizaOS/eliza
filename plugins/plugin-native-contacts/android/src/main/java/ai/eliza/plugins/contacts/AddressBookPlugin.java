package ai.eliza.plugins.contacts;

import android.Manifest;
import android.app.KeyguardManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.CancellationSignal;
import android.os.UserManager;
import android.provider.ContactsContract;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicLong;

/**
 * The address book of the AOSP telephony profile: bounded same-profile reads through
 * {@link ContactsCatalog} while the phone is unlocked with the host in front, and contact creation
 * and edits handed to the system Contacts editor, which owns the account choice and the save. No
 * contact is written from here.
 *
 * A host subclasses this under its own plugin name (declaring the {@code contacts} permission alias
 * for READ_CONTACTS) and decides {@link #admitted()} natively, from facts an ordinary install cannot
 * produce. Reads are cancelled and their results dropped on pause, resume, screen-off and permission
 * change. Edits recheck the selected contact's lookup key and revision first. The editor is always a
 * system app's exported activity, never a component, URI, account or payload from the renderer.
 */
public abstract class AddressBookPlugin extends Plugin {
  /** Fixed answer for a request that reached a destroyed activity; it claims nothing about the effect. */
  public static final String CLOSED = "Android could not show this request; the app may have closed. Reopen it and try again.";
  public static final String UNAVAILABLE = "Contacts is available only on the phone's system image while it is unlocked.";

  /** Whether the host's capability profile admits this install. Checked before every request. */
  protected abstract boolean admitted();

  /** The answer when the profile does not admit this install or the phone is locked or in the background. */
  protected String unavailableMessage() {
    return UNAVAILABLE;
  }

  /** The answer for a request made after the activity is gone. */
  protected String closedMessage() {
    return CLOSED;
  }

  private final ExecutorService worker = Executors.newSingleThreadExecutor();
  private volatile boolean closed, resumed = true;
  private final AtomicLong generation = new AtomicLong();
  private final Set<CancellationSignal> reads = ConcurrentHashMap.newKeySet();
  private final android.content.BroadcastReceiver screenOff = new android.content.BroadcastReceiver() {
    @Override
    public void onReceive(Context context, Intent intent) {
      invalidateReads();
    }
  };

  @Override
  public void load() {
    CapacitorPlugin annotation = getClass().getAnnotation(CapacitorPlugin.class);
    boolean declared = false;
    if (annotation != null) for (Permission permission : annotation.permissions()) declared |= "contacts".equals(permission.alias());
    if (!declared) throw new IllegalStateException("Address book host plugin must declare permission alias contacts");
    androidx.core.content.ContextCompat.registerReceiver(getContext(), screenOff, new IntentFilter(Intent.ACTION_SCREEN_OFF), androidx.core.content.ContextCompat.RECEIVER_NOT_EXPORTED);
  }

  private void invalidateReads() {
    generation.incrementAndGet();
    for (CancellationSignal signal : reads) signal.cancel();
  }

  @Override
  protected void handleOnPause() {
    resumed = false;
    invalidateReads();
    super.handleOnPause();
  }

  @Override
  protected void handleOnResume() {
    resumed = true;
    invalidateReads();
    super.handleOnResume();
  }

  private boolean available() {
    return !closed && admitted();
  }

  private boolean unlocked() {
    KeyguardManager lock = getContext().getSystemService(KeyguardManager.class);
    UserManager users = getContext().getSystemService(UserManager.class);
    return resumed && lock != null && users != null && !lock.isDeviceLocked() && users.isUserUnlocked()
      && (android.os.Build.VERSION.SDK_INT < 31 || users.isUserForeground());
  }

  private boolean readable() {
    return available() && unlocked() && getContext().checkSelfPermission(Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED;
  }

  private boolean foreground() {
    return available() && unlocked() && getActivity() != null && !getActivity().isFinishing() && !getActivity().isDestroyed() && getActivity().hasWindowFocus();
  }

  /** Runs a request that launches through the activity; a destroyed activity rejects instead of crashing the bridge thread. */
  private boolean launch(PluginCall call, Runnable start) {
    try {
      start.run();
      return true;
    } catch (IllegalStateException gone) {
      call.reject(closedMessage());
      return false;
    }
  }

  @PluginMethod
  public void status(PluginCall call) {
    JSObject out = new JSObject();
    out.put("available", available());
    out.put("readable", readable());
    call.resolve(out);
  }

  @Override
  @PluginMethod
  public void requestPermissions(PluginCall call) {
    if (!foreground()) {
      call.reject(unavailableMessage());
      return;
    }
    launch(call, () -> requestPermissionForAlias("contacts", call, "permissionResult"));
  }

  @PermissionCallback
  private void permissionResult(PluginCall call) {
    invalidateReads();
    status(call);
  }

  /** One bounded page; `query` at most 128 characters, `limit` 1 to 200. */
  @PluginMethod
  public void list(PluginCall call) {
    if (!readable()) {
      call.reject("Contacts access is unavailable");
      return;
    }
    long ticket = generation.get();
    CancellationSignal cancel = new CancellationSignal();
    reads.add(cancel);
    try {
      worker.execute(() -> {
        try {
          if (!readable() || cancel.isCanceled() || ticket != generation.get()) throw new SecurityException();
          JSObject result = new ContactsCatalog(getContext()).list(call.getString("query", ""), call.getInt("limit", 50), cancel);
          android.app.Activity activity = getActivity();
          if (activity == null) {
            call.reject(closedMessage());
            return;
          }
          activity.runOnUiThread(() -> {
            if (readable() && !cancel.isCanceled() && ticket == generation.get()) call.resolve(result);
            else call.reject("Contacts access changed. Refresh after unlocking.");
          });
        } catch (Exception unavailable) {
          call.reject("Contacts could not be read. Check access and refresh.");
        } finally {
          reads.remove(cancel);
        }
      });
    } catch (RejectedExecutionException retired) {
      reads.remove(cancel);
      call.reject("Contacts closed");
    }
  }

  /** Opens the system editor for a new contact; the person chooses the account and saves there. */
  @PluginMethod
  public void create(PluginCall call) {
    if (!foreground()) {
      call.reject(unavailableMessage());
      return;
    }
    openEditor(call, new Intent(Intent.ACTION_INSERT).setType(ContactsContract.Contacts.CONTENT_TYPE));
  }

  /** Opens the system editor for a listed contact (`id`, `lookup`, `revision` as listed). */
  @PluginMethod
  public void edit(PluginCall call) {
    if (!foreground() || !readable()) {
      call.reject("Contacts access is unavailable");
      return;
    }
    try {
      worker.execute(() -> {
        try {
          Uri uri = new ContactsCatalog(getContext()).reviewed(call.getString("id"), call.getString("lookup"), call.getString("revision"));
          android.app.Activity activity = getActivity();
          if (activity == null) {
            call.reject(closedMessage());
            return;
          }
          activity.runOnUiThread(() -> {
            if (!foreground() || !readable()) {
              call.reject("Return to Contacts before editing");
              return;
            }
            openEditor(call, new Intent(Intent.ACTION_EDIT).setDataAndType(uri, ContactsContract.Contacts.CONTENT_ITEM_TYPE));
          });
        } catch (Exception unavailable) {
          call.reject("Contact changed or is unavailable. Refresh before editing.");
        }
      });
    } catch (RejectedExecutionException retired) {
      call.reject("Contacts closed");
    }
  }

  /** The first enabled, exported system activity other than this app that handles the intent; null when none. */
  static ActivityInfo systemEditor(List<ResolveInfo> handlers, String self) {
    if (handlers == null) return null;
    for (ResolveInfo handler : handlers) {
      ActivityInfo a = handler.activityInfo;
      if (a != null && a.enabled && a.exported && a.applicationInfo != null
        && (a.applicationInfo.flags & ApplicationInfo.FLAG_SYSTEM) != 0 && !self.equals(a.packageName)) return a;
    }
    return null;
  }

  private void openEditor(PluginCall call, Intent intent) {
    ActivityInfo editor = systemEditor(getContext().getPackageManager().queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY), getContext().getPackageName());
    if (editor == null) {
      call.reject("Android Contacts editor is unavailable");
      return;
    }
    intent.setComponent(new ComponentName(editor.packageName, editor.name));
    launch(call, () -> startActivityForResult(call, intent, "editorResult"));
  }

  /** The editor returned. Whether anything was saved is not claimed; the renderer reads the list again. */
  @ActivityCallback
  private void editorResult(PluginCall call, ActivityResult result) {
    if (call == null) return;
    JSObject out = new JSObject();
    out.put("status", "returned");
    call.resolve(out);
  }

  @Override
  protected void handleOnDestroy() {
    closed = true;
    invalidateReads();
    try {
      getContext().unregisterReceiver(screenOff);
    } catch (IllegalArgumentException notRegistered) {
      // load() failed before registering.
    }
    worker.shutdown();
    super.handleOnDestroy();
  }
}
