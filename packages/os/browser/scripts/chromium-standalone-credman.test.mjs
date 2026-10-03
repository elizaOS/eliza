/** Executes the actual transformed Java support provider; Android/base collaborators are controlled test doubles. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { applyStandaloneCredMan } from "./chromium/standalone-credman.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const prefix =
  "components/webauthn/android/java/src/org/chromium/components/webauthn/";
async function transformed() {
  const files = {};
  for (const name of [
    "AuthenticatorImpl.java",
    "Fido2CredentialRequest.java",
    "cred_man/CredManSupportProvider.java",
  ])
    files[prefix + name] = await readFile(
      path.join(here, "chromium/fixtures", prefix + name),
      "utf8",
    );
  applyStandaloneCredMan(
    (name, edit) => {
      files[name] = edit(files[name]);
    },
    (source, before, after) => {
      assert.equal(source.split(before).length, 2);
      return source.replace(before, after);
    },
  );
  return files;
}

test("actual Java backend selection requires platform service and absent GMS, preserving old/present GMS", async () => {
  const files = await transformed();
  const root = await mkdtemp(path.join(tmpdir(), "eliza-credman-java-"));
  const stubs = {
    "android/content/Context.java":
      'package android.content; public class Context { public static final String CREDENTIAL_SERVICE="credential"; public static Object credential; public Object getSystemService(String key){return credential;} }',
    "android/os/Build.java":
      "package android.os; public class Build { public static class VERSION { public static int SDK_INT=34; } public static class VERSION_CODES { public static final int UPSIDE_DOWN_CAKE=34; } }",
    "org/jni_zero/CalledByNative.java":
      "package org.jni_zero; public @interface CalledByNative {}",
    "org/chromium/base/ContextUtils.java":
      "package org.chromium.base; public class ContextUtils { public static android.content.Context getApplicationContext(){return new android.content.Context();} }",
    "org/chromium/base/ResettersForTesting.java":
      "package org.chromium.base; public class ResettersForTesting { public static void register(Runnable r){} }",
    "org/chromium/base/ServiceLoaderUtil.java":
      "package org.chromium.base; public class ServiceLoaderUtil { public static <T> T maybeCreate(Class<T> c){return null;} }",
    "org/chromium/base/TriState.java":
      "package org.chromium.base; public @interface TriState { int NOT_SET=0, TRUE=1, FALSE=2; }",
    "org/chromium/base/metrics/RecordHistogram.java":
      "package org.chromium.base.metrics; public class RecordHistogram { public static void recordBooleanHistogram(String s, boolean b){} }",
    "org/chromium/base/version_info/VersionInfo.java":
      "package org.chromium.base.version_info; public class VersionInfo { public static boolean isBetaBuild(){return false;} public static boolean isStableBuild(){return true;} }",
    "org/chromium/build/annotations/NullMarked.java":
      "package org.chromium.build.annotations; public @interface NullMarked {}",
    "org/chromium/build/annotations/Nullable.java":
      "package org.chromium.build.annotations; public @interface Nullable {}",
    "org/chromium/components/webauthn/CredManSupport.java":
      "package org.chromium.components.webauthn; public @interface CredManSupport { int NOT_EVALUATED=0, DISABLED=1, FULL_UNLESS_INAPPLICABLE=2, PARALLEL_WITH_FIDO_2=3; }",
    "org/chromium/components/webauthn/GmsCoreUtils.java":
      "package org.chromium.components.webauthn; public class GmsCoreUtils { public static int version=-1; public static int getGmsCoreVersion(){return version;} }",
    "org/chromium/components/webauthn/WebauthnLogger.java":
      "package org.chromium.components.webauthn; public class WebauthnLogger { public static void log(String tag,String s,Object... a){} }",
    "org/chromium/components/webauthn/WebauthnFeatureMap.java":
      'package org.chromium.components.webauthn; public class WebauthnFeatureMap { public static WebauthnFeatureMap getInstance(){return new WebauthnFeatureMap();} public boolean isEnabled(String s){return false;} public String getFieldTrialParamByFeature(String a,String b){return "";} }',
    "org/chromium/components/webauthn/WebauthnFeatures.java":
      'package org.chromium.components.webauthn; public class WebauthnFeatures { public static final String WEBAUTHN_ANDROID_CRED_MAN_FOR_DEV="dev"; }',
    "org/chromium/components/webauthn/WebauthnMode.java":
      "package org.chromium.components.webauthn; public class WebauthnMode { public static final int CHROME=1, CHROME_3PP_ENABLED=2; }",
    "org/chromium/components/webauthn/WebauthnModeProvider.java":
      "package org.chromium.components.webauthn; public class WebauthnModeProvider { public static int mode=1; public static WebauthnModeProvider getInstance(){return new WebauthnModeProvider();} public int getGlobalWebauthnMode(){return mode;} }",
    "org/chromium/components/webauthn/cred_man/CredManUiRecommender.java":
      "package org.chromium.components.webauthn.cred_man; public interface CredManUiRecommender { boolean recommendsCustomUi(); }",
    "CredManTest.java": `import android.content.Context;
import android.os.Build;
import org.chromium.components.webauthn.*;
import org.chromium.components.webauthn.cred_man.CredManSupportProvider;
public class CredManTest {
 static void check(int sdk, int gms, boolean service, boolean standalone, int expected) {
  Build.VERSION.SDK_INT=sdk; GmsCoreUtils.version=gms; Context.credential=service?new Object():null;
  // Null/NOT_SET resets cache without bypassing either production availability gate.
  CredManSupportProvider.setupForTesting(null, org.chromium.base.TriState.NOT_SET);
  if(CredManSupportProvider.canDispatchStandaloneCredMan()!=standalone) throw new AssertionError("dispatch");
  if(CredManSupportProvider.getCredManSupport()!=expected) throw new AssertionError("backend");
 }
 public static void main(String[] args) {
  check(33,-1,true,false,CredManSupport.DISABLED);
  check(34,-1,false,false,CredManSupport.DISABLED);
  check(34,-1,true,true,CredManSupport.FULL_UNLESS_INAPPLICABLE);
  // A disappearing service cannot leave a cached standalone/provider capability.
  Context.credential=null;
  if(CredManSupportProvider.canDispatchStandaloneCredMan()) throw new AssertionError("stale service");
  check(34,10000000,true,false,CredManSupport.DISABLED);
  check(34,242300000,false,false,CredManSupport.DISABLED);
  check(34,242300000,true,false,CredManSupport.PARALLEL_WITH_FIDO_2);
  WebauthnModeProvider.mode=99;
  check(34,-1,true,false,CredManSupport.DISABLED);
  WebauthnModeProvider.mode=WebauthnMode.CHROME_3PP_ENABLED;
  check(34,242300000,true,false,CredManSupport.FULL_UNLESS_INAPPLICABLE);
  System.out.println("actual transformed Java: 8 backend cases plus service disappearance passed");
 }
}`,
  };
  try {
    stubs[
      "org/chromium/components/webauthn/cred_man/CredManSupportProvider.java"
    ] = files[`${prefix}cred_man/CredManSupportProvider.java`];
    const paths = [];
    for (const [name, content] of Object.entries(stubs)) {
      const file = path.join(root, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
      paths.push(file);
    }
    execFileSync("javac", ["-d", path.join(root, "classes"), ...paths], {
      stdio: "pipe",
    });
    const result = execFileSync(
      "java",
      ["-ea", "-cp", path.join(root, "classes"), "CredManTest"],
      { encoding: "utf8" },
    );
    assert.match(result, /8 backend cases/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("standalone routing retains origin, focus and cancellation checks and denies GMS-only capabilities", async () => {
  const files = await transformed();
  const auth = files[`${prefix}AuthenticatorImpl.java`];
  const request = files[`${prefix}Fido2CredentialRequest.java`];
  assert.match(
    auth,
    /!GmsCoreUtils.isWebauthnSupported\(\) && !canDispatchStandaloneCredMan\(\)/,
  );
  assert.match(
    auth,
    /options.isConditional \|\| options.isPaymentCredentialCreation/,
  );
  assert.match(
    auth,
    /options.mediation == Mediation.CONDITIONAL[\s\S]*options.mediation == Mediation.IMMEDIATE/,
  );
  assert.match(
    auth,
    /CAPABILITY_HYBRID_TRANSPORT, GmsCoreUtils.isWebauthnSupported\(\)/,
  );
  assert.match(
    auth,
    /private boolean couldSupportUvpaa\(\) \{\s*return GmsCoreUtils.isWebauthnSupported\(\)/,
  );
  assert.match(
    request,
    /if \(mPlayServicesAvailable\s*&& is\(mAuthenticationContextProvider.getWebContents\(\), WebauthnMode.CHROME\)\)/,
  );
  for (const token of [
    "performMakeCredentialWebAuthSecurityChecks(",
    "performGetAssertionWebAuthSecurityChecks(",
    "buildClientDataJsonAndComputeHash(",
    "CANCEL_PENDING_RP_ID_VALIDATION_COMPLETE",
    "mCredManHelper.cancelGetAssertion(AuthenticatorStatus.ABORT_ERROR)",
  ])
    assert.ok(request.includes(token), token);
  assert.ok(
    auth.includes("mWebContents.getVisibility() != Visibility.VISIBLE"),
  );
  assert.match(
    request,
    /chromeRequest && CredManSupportProvider.canDispatchStandaloneCredMan\(\)[\s\S]*onIsUserVerifyingPlatformAuthenticatorAvailableResponse\(false\)/,
  );
});
