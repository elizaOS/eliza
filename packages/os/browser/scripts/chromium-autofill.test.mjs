// Compiles and exercises the actual patched Chromium FormData, with Android surface doubles.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = new URL("./chromium/", import.meta.url);

import { applyAutofillFullOrigin } from "./chromium/autofill-full-origin.mjs";

const manifest = JSON.parse(
  await readFile(new URL("autofill/upstream.json", root), "utf8"),
);
const work = await mkdtemp(join(tmpdir(), "eliza-autofill-"));
// biome-ignore lint/suspicious/noUndeclaredEnvVars: direct test harness selects the installed JDK outside Turbo.
const javaHome = process.env.JAVA_HOME;
const javaTool = (name) => (javaHome ? join(javaHome, "bin", name) : name);
try {
  for (const [path, digest] of Object.entries(manifest.sha256)) {
    const source = await readFile(new URL(`fixtures/${path}`, root));
    assert.equal(
      createHash("sha256").update(source).digest("hex"),
      digest,
      path,
    );
    await mkdir(dirname(join(work, path)), { recursive: true });
    await writeFile(join(work, path), source);
  }
  const sources = {};
  for (const name of Object.keys(manifest.sha256))
    sources[name] = await readFile(join(work, name), "utf8");
  applyAutofillFullOrigin(
    (name, transform) => {
      sources[name] = transform(sources[name]);
    },
    (source, before, after) => {
      assert.equal(source.split(before).length, 2);
      return source.replace(before, after);
    },
  );
  for (const [name, source] of Object.entries(sources))
    await writeFile(join(work, name), source);
  const bridge = await readFile(
    join(
      work,
      "components/android_autofill/browser/form_data_android_bridge_impl.cc",
    ),
    "utf8",
  );
  assert.match(
    bridge,
    /form\.url\(\)\.DeprecatedGetOriginAsURL\(\)\.spec\(\),\s+form\.main_frame_origin\(\)\.Serialize\(\), android_objects/,
  );
  const files = [];
  async function source(path, text) {
    const file = join(work, "src", path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
    files.push(file);
  }
  await source(
    "org/chromium/components/autofill/FormData.java",
    await readFile(
      join(
        work,
        "components/android_autofill/browser/java/src/org/chromium/components/autofill/FormData.java",
      ),
      "utf8",
    ),
  );
  for (const [pkg, name] of [
    ["androidx.annotation", "VisibleForTesting"],
    ["org.jni_zero", "CalledByNative"],
    ["org.jni_zero", "JNINamespace"],
    ["org.jni_zero", "JniType"],
    ["org.chromium.build.annotations", "NullMarked"],
  ])
    await source(
      `${pkg.replaceAll(".", "/")}/${name}.java`,
      `package ${pkg}; public @interface ${name} {String value() default "";}`,
    );
  await source(
    "org/chromium/build/NullUtil.java",
    "package org.chromium.build; public class NullUtil {public static <T>T assumeNonNull(T value){return value;}}",
  );
  await source(
    "android/graphics/RectF.java",
    "package android.graphics; public class RectF {public float left,top;public float width(){return 100;}public float height(){return 20;}}",
  );
  await source(
    "android/view/View.java",
    "package android.view; public class View {public static final int VISIBLE=0,INVISIBLE=4,AUTOFILL_TYPE_LIST=3,AUTOFILL_TYPE_TEXT=1;}",
  );
  await source(
    "android/os/Bundle.java",
    "package android.os; public class Bundle extends java.util.HashMap<String,Object> {public void putInt(String key,int value){put(key,value);}public void putString(String key,String value){put(key,value);}}",
  );
  await source(
    "android/view/autofill/AutofillValue.java",
    "package android.view.autofill; public class AutofillValue {public static AutofillValue forList(int value){return new AutofillValue();}public static AutofillValue forText(String value){return new AutofillValue();}}",
  );
  await source(
    "android/view/ViewStructure.java",
    `package android.view;
public class ViewStructure {
 public final android.os.Bundle extras=new android.os.Bundle();public final java.util.List<ViewStructure> children=new java.util.ArrayList<>();public String domain;public String[] hints;public boolean focused;
 public android.os.Bundle getExtras(){return extras;} public void setWebDomain(String value){domain=java.net.URI.create(value).getHost();}
 public void setHtmlInfo(HtmlInfo info){}public HtmlInfo.Builder newHtmlInfoBuilder(String tag){return new HtmlInfo.Builder();}
 public int addChildCount(int count){return children.size();}public ViewStructure newChild(int index){ViewStructure child=new ViewStructure();children.add(child);return child;}
 public void setFocused(boolean value){focused=value;}public Object getAutofillId(){return this;}public void setAutofillId(Object parent,int id){}
 public void setAutofillHints(String[] value){hints=value;}public void setHint(String hint){}public void setDimens(int a,int b,int c,int d,int e,int f){}public void setVisibility(int value){}
 public void setAutofillType(int type){}public void setAutofillOptions(String[] options){}public void setAutofillValue(android.view.autofill.AutofillValue value){}
 public static class HtmlInfo {public static class Builder {public Builder addAttribute(String key,String value){return this;}public HtmlInfo build(){return new HtmlInfo();}}}
}`,
  );
  await source(
    "org/chromium/components/autofill/AndroidAutofillFeatures.java",
    "package org.chromium.components.autofill; public class AndroidAutofillFeatures {public static final AndroidAutofillFeatures ANDROID_AUTOFILL_IMPROVED_VISIBILITY_DETECTION=new AndroidAutofillFeatures();public boolean isEnabled(){return true;}}",
  );
  await source(
    "org/chromium/components/autofill/FormFieldData.java",
    `package org.chromium.components.autofill;
public class FormFieldData {
 public String mAutocompleteAttr,mOrigin,mPlaceholder,mName,mType,mLabel,mHeuristicType,mId; public String[] mOptionContents={},mOptionValues={},mDatalistValues={};public int mMaxLength;
 public static class ControlType {public static final int LIST=1,TOGGLE=2,TEXT=3,DATALIST=4;}
 public void setAutofillId(Object id){}public android.graphics.RectF getBoundsInContainerViewCoordinates(){return new android.graphics.RectF();}public boolean getFocusable(){return true;}public boolean getVisible(){return true;}
 public String getServerType(){return "";}public String getOverallType(){return "";}public String[] getServerPredictions(){return new String[0];}public int getControlType(){return ControlType.TEXT;}public String getValue(){return "";}
}`,
  );
  await source(
    "org/chromium/components/autofill/OriginTransportTest.java",
    `package org.chromium.components.autofill;
public class OriginTransportTest {
 static void equal(Object actual,Object expected){if(!java.util.Objects.equals(actual,expected))throw new AssertionError("Origin transport mismatch");}
 public static void main(String[] args){
  String origin="https://example.test:8443";FormFieldData username=new FormFieldData();username.mOrigin=origin;username.mAutocompleteAttr="username";
  FormFieldData password=new FormFieldData();password.mOrigin="https://other.test:9443";password.mAutocompleteAttr="current-password";
  FormData form=FormData.createFormData(1,"page-controlled-form-name",origin,"https://top.test:443",java.util.List.of(username,password));
  android.view.ViewStructure output=new android.view.ViewStructure();form.fillViewStructure(output,(short)0);
  equal(output.domain,"example.test");equal(output.extras.get("ai.elizaresearch.autofill.version"),1);
  equal(output.extras.get("ai.elizaresearch.autofill.origin"),origin);equal(output.extras.get("ai.elizaresearch.autofill.topOrigin"),"https://top.test:443");
  equal(output.children.get(0).extras.get("ai.elizaresearch.autofill.fieldOrigin"),origin);equal(output.children.get(1).extras.get("ai.elizaresearch.autofill.fieldOrigin"),"https://other.test:9443");
  equal(output.children.get(0).hints[0],"username");equal(output.children.get(1).hints[0],"current-password");
  android.view.ViewStructure missing=new android.view.ViewStructure();new FormData(2,"untrusted",origin,java.util.List.of(username)).fillViewStructure(missing,(short)0);equal(missing.extras.get("ai.elizaresearch.autofill.topOrigin"),"");
  System.out.println("PASS patched Chromium FormData preserves browser full origins, ports, per-field mismatch and missing-top fail-closed marker");
 }
}`,
  );
  execFileSync(javaTool("javac"), ["-d", join(work, "classes"), ...files], {
    stdio: "pipe",
  });
  const result = execFileSync(
    javaTool("java"),
    [
      "-cp",
      join(work, "classes"),
      "org.chromium.components.autofill.OriginTransportTest",
    ],
    { encoding: "utf8" },
  );
  process.stdout.write(result);
} finally {
  await rm(work, { recursive: true, force: true });
}
