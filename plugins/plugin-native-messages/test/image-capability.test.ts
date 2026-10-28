/**
 * Compiles the shared native image capability (ImageCapability.java) against
 * small Android stand-ins and checks every admission fact is required. Skips
 * only when no JDK is installed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const shared = path.join(
  root,
  "android/src/main/java/ai/eliza/plugins/messages",
);
const java = (name: string) =>
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;
const hasJdk = spawnSync(java("javac"), ["-version"]).status === 0;

const stubs: Record<string, string> = {
  "android/content/BroadcastReceiver.java":
    "package android.content; public abstract class BroadcastReceiver {}",
  "android/content/pm/ApplicationInfo.java":
    "package android.content.pm; public class ApplicationInfo {public static final int FLAG_SYSTEM=1;public int flags;}",
  "android/content/pm/PackageManager.java":
    'package android.content.pm; public class PackageManager {public java.util.Map<String,Integer> features=new java.util.HashMap<>();public boolean throwOnRead;public int reads;public boolean hasSystemFeature(String name,int version){reads++;if(throwOnRead)throw new RuntimeException("unreadable");Integer v=features.get(name);return v!=null&&v>=version;}}',
  "android/content/res/Resources.java":
    "package android.content.res; public class Resources {public static class NotFoundException extends RuntimeException {}public java.util.Map<Integer,Boolean> values=new java.util.HashMap<>();public boolean getBoolean(int id){Boolean v=values.get(id);if(v==null)throw new NotFoundException();return v;}}",
  "android/content/Context.java":
    'package android.content; public class Context {public String packageName="org.example.host";public android.content.pm.ApplicationInfo info=new android.content.pm.ApplicationInfo();public android.content.pm.PackageManager packages=new android.content.pm.PackageManager();public android.content.res.Resources resources=new android.content.res.Resources();public android.content.pm.ApplicationInfo getApplicationInfo(){return info;}public Context getApplicationContext(){return null;}public android.content.pm.PackageManager getPackageManager(){return packages;}public String getPackageName(){return packageName;}public android.content.res.Resources getResources(){return resources;}}',
  "CapabilityCheck.java": `import ai.eliza.plugins.messages.ImageCapability;
import ai.eliza.plugins.messages.SmsTelephonyConfiguration;
public class CapabilityCheck {
 static void check(boolean ok, String what){if(!ok)throw new AssertionError(what);}
 static android.content.Context image(){android.content.Context c=new android.content.Context();c.info.flags=1;c.resources.values.put(7,true);c.packages.features.put("org.example.host.aosp_image",1);return c;}
 public static void main(String[] args){
  for(int mask=0;mask<64;mask++)check(ImageCapability.admitted((mask&1)!=0,(mask&2)!=0,(mask&4)!=0,(mask&8)!=0,(mask&16)!=0,(mask&32)!=0)==(mask==57),"decision "+mask);
  check(ImageCapability.featureName("org.example.host").equals("org.example.host.aosp_image"),"feature name");
  for(String bad:new String[]{null,"","host","Org.example","org..example","org.example/x"}){try{ImageCapability.featureName(bad);check(false,"accepted "+bad);}catch(IllegalArgumentException expected){}}
  try{new ImageCapability(true,false,false,-1);check(false,"negative resource");}catch(IllegalArgumentException expected){}
  SmsTelephonyConfiguration.Admission admission=new ImageCapability(true,false,false,7);
  check(admission.admitted(image()),"image admitted");
  check(new ImageCapability(true,false,false,7).provisioned(image()),"image provisioned");
  check(!new ImageCapability(true,false,false,7).provisioned(null),"no context");
  check(!new ImageCapability(false,false,false,7).admitted(image()),"non-launcher build");
  check(!new ImageCapability(true,true,false,7).admitted(image()),"debug build");
  check(!new ImageCapability(true,false,true,7).admitted(image()),"test-mocks build");
  android.content.Context sideloaded=image();sideloaded.info.flags=0;
  check(!new ImageCapability(true,false,false,7).provisioned(sideloaded)&&!new ImageCapability(true,false,false,7).admitted(sideloaded),"sideloaded install");
  android.content.Context unprovisioned=image();unprovisioned.resources.values.put(7,false);
  check(!new ImageCapability(true,false,false,7).provisioned(unprovisioned)&&!new ImageCapability(true,false,false,7).admitted(unprovisioned),"overlay absent");
  android.content.Context missing=image();missing.resources.values.clear();
  check(!new ImageCapability(true,false,false,7).admitted(missing),"provisioning resource unreadable");
  android.content.Context noFeature=image();noFeature.packages.features.clear();
  check(new ImageCapability(true,false,false,7).provisioned(noFeature),"provisioning does not read the feature");
  check(!new ImageCapability(true,false,false,7).admitted(noFeature),"feature absent");
  android.content.Context oldFeature=image();oldFeature.packages.features.put("org.example.host.aosp_image",0);
  check(!new ImageCapability(true,false,false,7).admitted(oldFeature),"feature version too old");
  android.content.Context other=image();other.packages.features.clear();other.packages.features.put("org.other.host.aosp_image",1);
  check(!new ImageCapability(true,false,false,7).admitted(other),"another host's feature");
  android.content.Context unreadable=image();unreadable.packages.throwOnRead=true;
  check(!new ImageCapability(true,false,false,7).admitted(unreadable),"feature unreadable");
  android.content.Context imageOnly=image();imageOnly.resources.values.clear();
  check(new ImageCapability(true,false,false,0).admitted(imageOnly),"image-only host needs no overlay");
  imageOnly.info.flags=0;check(!new ImageCapability(true,false,false,0).admitted(imageOnly),"image-only host still needs a system install");
  ImageCapability cached=new ImageCapability(true,false,false,7);android.content.Context once=image();
  check(cached.admitted(once)&&cached.admitted(once)&&once.packages.reads==1,"image facts read once");
  once.resources.values.put(7,false);check(!cached.admitted(once),"provisioning is not cached past a later refusal");
  System.out.println("ok");
 }
}
`,
};

describe.skipIf(!hasJdk)("shared native image capability", () => {
  it("requires every image fact and never infers one from another", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "image-capability-"));
    try {
      for (const [name, body] of Object.entries(stubs)) {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), body);
      }
      execFileSync(
        java("javac"),
        [
          "--release",
          "11",
          "-d",
          path.join(dir, "out"),
          path.join(shared, "ImageCapability.java"),
          path.join(shared, "SmsTelephonyConfiguration.java"),
          ...Object.keys(stubs).map((name) => path.join(dir, name)),
        ],
        { timeout: 60_000, stdio: "pipe" },
      );
      const output = execFileSync(
        java("java"),
        ["-cp", path.join(dir, "out"), "CapabilityCheck"],
        { encoding: "utf8", timeout: 30_000 },
      );
      expect(output.trim()).toBe("ok");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("names the same feature and version the image staging writes", () => {
    const source = fs.readFileSync(
      path.join(shared, "ImageCapability.java"),
      "utf8",
    );
    const staging = fs.readFileSync(
      path.join(root, "../../packages/os/scripts/android/image-capability.mjs"),
      "utf8",
    );
    const version = /IMAGE_FEATURE_VERSION = (\d+);/.exec(staging)?.[1];
    expect(version).toBeTruthy();
    expect(source).toContain(`FEATURE_VERSION = ${version};`);
    expect(staging).toContain(`return \`\${appId}.aosp_image\`;`);
    expect(source).toContain('return packageName + ".aosp_image";');
  });
});
