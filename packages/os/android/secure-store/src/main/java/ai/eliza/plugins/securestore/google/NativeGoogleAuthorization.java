// spec/cloud/identity/federatedSignIn.md, "Story: Connect mail and calendar from the same Google sheet"
package ai.eliza.plugins.securestore.google;

import ai.eliza.plugins.securestore.nativeonly.CloudDeviceAccount.NativeGoogleAttempt;
import android.accounts.Account;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.common.api.Scope;
import java.util.ArrayList;
import java.util.List;

public final class NativeGoogleAuthorization {
 private NativeGoogleAuthorization() {}

 public static AuthorizationRequest request(NativeGoogleAttempt attempt, String googleAccount) {
  return attempt.scopes().isEmpty() ? null : request(attempt.serverClientId(), googleAccount, attempt.scopes());
 }

 public static AuthorizationRequest request(String serverClientId, String googleAccount, List<String> scopes) {
  if (googleAccount == null || googleAccount.isEmpty() || googleAccount.length() > 320) throw new IllegalArgumentException("Invalid Google account");
  List<Scope> requested = new ArrayList<>();
  for (String scope : scopes) requested.add(new Scope(scope));
  return AuthorizationRequest.builder().setRequestedScopes(requested).setAccount(new Account(googleAccount, "com.google"))
      .requestOfflineAccess(serverClientId, true).build();
 }
}
