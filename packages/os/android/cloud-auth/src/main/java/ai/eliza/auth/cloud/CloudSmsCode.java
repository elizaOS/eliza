package ai.eliza.auth.cloud;

import java.util.List;
import org.json.JSONObject;

/** Tenant-bound Steward SMS sign-in. Never uses the website's tenant-stripping owner-phone alias. */
public final class CloudSmsCode {
 private CloudSmsCode() {}
 public static final String SEND_PATH = "/steward/auth/sms/send";
 public static final String VERIFY_PATH = "/steward/auth/sms/verify";
 public static boolean validPhone(String phone) { return phone != null && phone.matches("\\+[1-9][0-9]{6,14}"); }
 /** Steward offers SMS for the tenant, without a captcha this native client cannot answer. */
 public static boolean offered(int status, Object enabled, Object captchaEnabled, List<String> requiredFor) {
  if (status != 200 || !Boolean.TRUE.equals(enabled)) return false;
  return !Boolean.TRUE.equals(captchaEnabled) || (requiredFor != null && !requiredFor.contains("sms_otp") && !requiredFor.contains("sms"));
 }
 public static JSONObject sendBody(CloudSignInEnvironment environment, String phone) throws Exception {
  if (!validPhone(phone)) throw new IllegalArgumentException("Invalid phone number");
  return new JSONObject().put("phone", phone).put("tenantId", environment.tenant);
 }
 public static JSONObject verifyBody(CloudSignInEnvironment environment, String phone, String code) throws Exception {
  if (!CloudSignInFlow.validCode(code)) throw new IllegalArgumentException("Invalid code");
  return sendBody(environment, phone).put("code", code);
 }
}
