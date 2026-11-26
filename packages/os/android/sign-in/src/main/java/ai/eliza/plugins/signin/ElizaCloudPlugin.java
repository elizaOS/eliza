// spec/os/signIn/cloudRequests.md, "A cloud table is loaded only when every route is a device route the page may use"; spec/os/signIn/cloudRequests.md, "A request is sent only to the deployment origin, admitted by the gate, with headers its route admits"; spec/os/signIn/cloudRequests.md, "A reply body up to 8 MiB returns inline, up to 64 MiB through a one-use cache grant, and a larger one is refused"; spec/os/signIn/cloudRequests.md, "Only an HTTPS page on the web host or a listed payment or consent host opens, in the system browser"; spec/os/signIn/cloudRequests.md, "A cancel disconnects only the page's own call still in flight, which then settles once as cancelled"
package ai.eliza.plugins.signin;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import android.util.Log;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(name = "ElizaCloud")
public class ElizaCloudPlugin extends Plugin {
  public static final String NOT_CONFIGURED = "not-configured", UNKNOWN_ENVIRONMENT = "unknown-environment", INVALID_REQUEST = "invalid-request",
    GRANT_UNKNOWN = "grant-unknown", GRANT_UNREADABLE = "grant-unreadable", LINK_REFUSED = "link-refused", NO_BROWSER = "no-browser";

  private static final String TAG = "ElizaCloud";
  private static final String CALL_NAME = "[A-Za-z0-9-]{8,64}";
  private static final int WORKERS = 4;

  private final ExecutorService workers = Executors.newFixedThreadPool(WORKERS);
  private SignInRegistration registration;
  private CloudRequests requests;
  private LargeBodyGrant grants;

  protected String signInPluginName() { return "ElizaSignIn"; }

  protected CloudRequests.Custody custody(Context context, SignInRegistration.Environment environment) {
    return DeviceCustody.cloud(context, environment.apiOrigin);
  }

  @Override public void load() {
    grants = new LargeBodyGrant(getContext().getCacheDir());
    try {
      JSONObject signIn = getBridge().getConfig().getPluginConfiguration(signInPluginName()).getConfigJSON();
      registration = SignInRegistration.parse(CredentialJson.object(CredentialJson.parse(signIn.toString()), signInPluginName()));
    } catch (IllegalArgumentException refused) {
      Log.e(TAG, "The sign-in registration was refused, so no cloud request is sent", refused);
      return;
    }
    JSONArray table = getConfig().getConfigJSON().optJSONArray("routes");
    CloudRequestPolicy policy = new CloudRequestPolicy(table == null ? null : table.toString());
    if (!policy.loaded()) Log.e(TAG, "The cloud route table was refused whole, so no cloud request is admitted");
    requests = new CloudRequests(policy, grants);
  }

  @Override protected void handleOnDestroy() {
    workers.shutdownNow();
    grants.clear();
  }

  @PluginMethod public void request(PluginCall call) {
    if (requests == null) { call.reject(NOT_CONFIGURED, NOT_CONFIGURED); return; }
    SignInRegistration.Environment environment = registration.environment(call.getString("environment"));
    String method = call.getString("method"), target = call.getString("target");
    Map<String, String> headers = headers(call.getObject("headers", new JSObject()));
    Object body = call.getData().opt("body");
    String name = call.getString("id");
    Object credential = call.getData().opt("expectedCredentialId");
    Object billingCredential = call.getData().opt("expectedSessionCredentialId");
    boolean billingSession = billingCredential != null;
    Object binding = billingSession ? billingCredential : credential;
    String expectedCredentialId = binding instanceof String value ? value : null;
    if (environment == null) { call.reject(UNKNOWN_ENVIRONMENT, UNKNOWN_ENVIRONMENT); return; }
    if (method == null || target == null || headers == null || body != null && body != JSONObject.NULL && !(body instanceof String)
        || name != null && !name.matches(CALL_NAME)
        || billingSession && credential != null
        || binding != null && (expectedCredentialId == null || expectedCredentialId.isBlank() || expectedCredentialId.length() > 256)) {
      call.reject(INVALID_REQUEST, INVALID_REQUEST);
      return;
    }
    byte[] bytes = body instanceof String text ? text.getBytes(StandardCharsets.UTF_8) : null;
    run(call, () -> {
      switch (requests.send(name, environment.apiOrigin, custody(getContext(), environment), method.toUpperCase(Locale.ROOT), target, headers, bytes, expectedCredentialId, billingSession)) {
        case CloudRequests.Answered answered -> call.resolve(answered(answered));
        case CloudRequests.Failed failed -> call.reject(wire(failed.failure()), wire(failed.failure()));
      }
    });
  }

  @PluginMethod public void cancel(PluginCall call) {
    String name = call.getString("id");
    call.resolve(new JSObject().put("cancelled", requests != null && name != null && requests.cancel(name)));
  }

  @PluginMethod public void readGrant(PluginCall call) {
    String id = call.getString("grant");
    run(call, () -> {
      LargeBodyGrant.Chunk chunk;
      try {
        chunk = grants.read(id);
      } catch (IOException lost) {
        Log.e(TAG, "A granted reply body could not be read", lost);
        call.reject(GRANT_UNREADABLE, GRANT_UNREADABLE);
        return;
      }
      if (chunk == null) call.reject(GRANT_UNKNOWN, GRANT_UNKNOWN);
      else call.resolve(new JSObject().put("data", Base64.encodeToString(chunk.data(), Base64.NO_WRAP)).put("done", chunk.done()));
    });
  }

  @PluginMethod public void openExternal(PluginCall call) {
    if (registration == null) { call.reject(NOT_CONFIGURED, NOT_CONFIGURED); return; }
    SignInRegistration.Environment environment = registration.environment(call.getString("environment"));
    if (environment == null) { call.reject(UNKNOWN_ENVIRONMENT, UNKNOWN_ENVIRONMENT); return; }
    String url = call.getString("url");
    CloudRequestPolicy.ExternalLink link = url == null ? null : CloudRequestPolicy.linkOf(url);
    if (link == null || !CloudRequestPolicy.opensExternally(environment.appLinkHost, link)) { call.reject(LINK_REFUSED, LINK_REFUSED); return; }
    Intent view = new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    try {
      getContext().startActivity(view);
      call.resolve(new JSObject().put("opened", true));
    } catch (ActivityNotFoundException absent) {
      call.reject(NO_BROWSER, NO_BROWSER);
    }
  }

  private void run(PluginCall call, Runnable work) {
    try {
      workers.execute(work);
    } catch (RejectedExecutionException closed) {
      call.reject(NOT_CONFIGURED, NOT_CONFIGURED);
    }
  }

  private static JSObject answered(CloudRequests.Answered answered) {
    JSObject reply = new JSObject().put("status", answered.status());
    if (answered.etag() != null) reply.put("etag", answered.etag());
    if (answered.contentType() != null) reply.put("contentType", answered.contentType());
    if (answered.retryAfter() != null) reply.put("retryAfter", answered.retryAfter());
    LargeBodyGrant.Grant grant = answered.grant();
    if (grant == null) return reply.put("body", Base64.encodeToString(answered.body(), Base64.NO_WRAP));
    return reply.put("grant", new JSObject().put("id", grant.id()).put("size", grant.size()).put("sha256", grant.sha256()));
  }

  private static Map<String, String> headers(JSObject given) {
    Map<String, String> headers = new LinkedHashMap<>();
    for (Iterator<String> names = given.keys(); names.hasNext(); ) {
      String name = names.next();
      if (!(given.opt(name) instanceof String value)) return null;
      headers.put(name, value);
    }
    return headers;
  }

  private static String wire(CloudRequests.Failure failure) {
    return failure.name().toLowerCase(Locale.ROOT).replace('_', '-');
  }
}
