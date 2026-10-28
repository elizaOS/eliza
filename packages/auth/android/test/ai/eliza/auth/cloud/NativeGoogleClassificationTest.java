package ai.eliza.auth.cloud;
public final class NativeGoogleClassificationTest {
 static int checks;
 static void check(String code,String reason,CloudSignInFlow.GoogleFailure got){if(!java.util.Objects.equals(code,got.code)||!reason.equals(got.reason))throw new AssertionError(reason);checks++;}
 public static void main(String[] args){
check("invalid-request", "invalid-binding-input", CloudSignInFlow.googleFailure(CloudSignInFlow.GoogleStage.VERIFY, 400, false, "A valid tenantId and clientId are required"));
check("state-mismatch", "tenant-binding-mismatch", CloudSignInFlow.googleFailure(CloudSignInFlow.GoogleStage.VERIFY, 400, false, "tenantId does not match X-Steward-Tenant"));
check("provider-refused", "client-unavailable", CloudSignInFlow.googleFailure(CloudSignInFlow.GoogleStage.VERIFY, 404, false, "App client not found or disabled"));
check("unavailable", "native-google-unconfigured", CloudSignInFlow.googleFailure(CloudSignInFlow.GoogleStage.VERIFY, 503, false, "Native Google sign-in is not configured for this app"));
check("invalid-request", "pkce-challenge-invalid", CloudSignInFlow.googleFailure(CloudSignInFlow.GoogleStage.CHALLENGE, 400, false, "An S256 code challenge is required"));
check("invalid-request", "verification-input-invalid", CloudSignInFlow.googleFailure(CloudSignInFlow.GoogleStage.VERIFY, 400, false, "challengeId, idToken and codeVerifier are required"));
check("expired", "challenge-unavailable", CloudSignInFlow.googleFailure(CloudSignInFlow.GoogleStage.VERIFY, 401, false, "Sign-in challenge expired or was already used"));
check("state-mismatch", "challenge-request-mismatch", CloudSignInFlow.googleFailure(CloudSignInFlow.GoogleStage.VERIFY, 401, false, "Sign-in challenge does not match this request"));
check("provider-refused", "google-identity-unverified", CloudSignInFlow.googleFailure(CloudSignInFlow.GoogleStage.VERIFY, 401, false, "Google identity could not be verified"));
check("expired", "challenge-consumed", CloudSignInFlow.googleFailure(CloudSignInFlow.GoogleStage.VERIFY, 401, false, "Sign-in challenge was already used"));
check("provider-refused", "identity-proof-unavailable", CloudSignInFlow.googleFailure(CloudSignInFlow.GoogleStage.VERIFY, 401, false, "Google identity token was already used or expired"));
check("rate-limited", "rate-limited", CloudSignInFlow.googleFailure(CloudSignInFlow.GoogleStage.VERIFY, 429, false, "Too many sign-in attempts. Try again later."));
  for(int status:new int[]{400,401,404}){
   for(Object error:new Object[]{null,"<html>secret</html>","Bearer secret.jwt.payload","https://evil.test/?token=secret", "Google identity could not be verified\nsecret",new Object(){public String toString(){throw new AssertionError("must not stringify");}}}){
    CloudSignInFlow.GoogleFailure f=CloudSignInFlow.googleFailure(CloudSignInFlow.GoogleStage.VERIFY,status,false,error);
    check("rejected","unclassified-provider-refusal",f);
    String log=CloudSignInFlow.googleDiagnostic(CloudSignInFlow.GoogleStage.VERIFY,status,f,1000,5000,2000);
    if(log.contains("secret")||log.contains("http")||log.length()>200)throw new AssertionError("unsafe diagnostic");checks++;
   }
  }
  check("rejected","unclassified-provider-refusal",CloudSignInFlow.googleFailure(CloudSignInFlow.GoogleStage.VERIFY,400,false,"Google identity could not be verified"));
  check("rejected","unclassified-provider-refusal",CloudSignInFlow.googleFailure(CloudSignInFlow.GoogleStage.VERIFY,401,true,"Google identity could not be verified"));
  check("rejected","unclassified-provider-refusal",CloudSignInFlow.googleFailure(CloudSignInFlow.GoogleStage.CHALLENGE,401,false,"Google identity could not be verified"));
  check("expired","http-expired",CloudSignInFlow.googleFailure(CloudSignInFlow.GoogleStage.VERIFY,410,null,null));
  check("expired","local-deadline",CloudSignInFlow.googleFailure(CloudSignInFlow.GoogleStage.LOCAL_DEADLINE,0,null,null));
  check(null,"response-received",CloudSignInFlow.googleFailure(CloudSignInFlow.GoogleStage.VERIFY,200,false,"Google identity could not be verified"));
  if(!"expired".equals(CloudSignInFlow.failureForStatus("exchange",401))||!"invalid-code".equals(CloudSignInFlow.failureForStatus("verify",401))||!"invalid-code".equals(CloudSignInFlow.failureForStatus("mfa",400)))throw new AssertionError("legacy changed");checks+=3;
  String log=CloudSignInFlow.googleDiagnostic(CloudSignInFlow.GoogleStage.LOCAL_DEADLINE,0,CloudSignInFlow.googleFailure(CloudSignInFlow.GoogleStage.LOCAL_DEADLINE,0,null,null),1000,2000,2500);
  if(!log.equals("stage=local_deadline status=0 reason=local-deadline elapsedMs=1500 deadlineRemainingMs=-500"))throw new AssertionError(log);checks++;
  System.out.println("PASS native Google classification ("+checks+" checks)");
 }
}
