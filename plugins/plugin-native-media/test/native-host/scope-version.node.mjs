import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Runs the production scope-version and resume methods on a host JVM against a synthetic catalog.
// Not Android or MediaStore evidence: PermittedMediaConsumerTest covers the real provider.
const plugin = fileURLToPath(new URL("../..", import.meta.url));
const media = path.join(plugin, "android/src/main/java/ai/eliza/plugins/media");
/** @param {string} name */
const bin = (name) =>
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;
/** @param {string} name */
const source = (name) =>
  fs.readFileSync(path.join(media, `${name}.java`), "utf8");
/**
 * @param {string} text
 * @param {string} from
 * @param {string} to
 */
const between = (text, from, to) => {
  const start = text.indexOf(from);
  assert.ok(start >= 0, `missing ${from}`);
  const end = text.indexOf(to, start + from.length);
  assert.ok(end > start, `missing ${to}`);
  return text.slice(start, end);
};

test("pause and resume keep the scope version; a grant or volume version changes it; paused row changes refresh", (t) => {
  const catalog = source("PermittedMediaCatalog");
  const scopeVersion = between(
    catalog,
    "  public String scopeVersion()",
    "  /** A {@code next} cursor",
  );
  const generations = between(
    catalog,
    "  public String generations()",
    "  public void requireCurrent(",
  );
  const plugin = source("DeviceLibraryPlugin");
  const scopeResult = between(
    plugin,
    "  private JSObject scopeResult() {",
    "  private boolean readable(",
  );
  const resume = between(
    plugin,
    "  protected void handleOnResume() {",
    "  @Override\n  protected void handleOnDestroy()",
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-version-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "ScopeVersionFixture.java");
  fs.writeFileSync(
    file,
    `import java.util.*;
public class ScopeVersionFixture {
 static class Build{static class VERSION{static int SDK_INT=34;}}
 static class Base64{static final int URL_SAFE=1,NO_WRAP=2,NO_PADDING=4;static String encodeToString(byte[] b,int f){return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(b);}}
 static class JSObject extends TreeMap<String,Object>{}
 static class Looper{static Looper getMainLooper(){return null;}}
 static class Handler{Handler(Looper l){}void post(Runnable r){r.run();}}
 static class PhotoLibraryAccess{static void scope(JSObject access,int sdk,boolean locked,String version,JSObject out)throws org.json.JSONException{out.putAll(access);out.put("locked",locked);out.put("version",version);}}
 static class org{static class json{static class JSONException extends Exception{}}}
 static Map<String,Long> rows=new TreeMap<>();
 static class MediaStore{static long getGeneration(Object context,String volume){return rows.getOrDefault(volume,0L);}}
 /** The catalog side: a grant, volume versions, and the epoch and generations a fence holds. */
 static class Catalog{
  String scope="full";Map<String,String> versions=new TreeMap<>(Map.of("external_primary","v1"));long epoch;Object context;
  void unlocked(){}
  JSObject access(){JSObject a=new JSObject();a.put("scope",scope);return a;}
  List<String> volumes(){return new ArrayList<>(versions.keySet());}
  String version(String volume){return versions.get(volume);}
  void foreground(boolean value){epoch++;}
${scopeVersion}
${generations}
 }
 Catalog catalog=new Catalog();boolean destroyed,locked;List<JSObject> announced=new ArrayList<>();
 boolean locked(){return locked;}
 int refreshes;
 void notifyListeners(String event,JSObject data){if(event.equals("libraryChanged")){refreshes++;return;}if(!event.equals("scopeChanged"))throw new AssertionError(event);announced.add(data);}
${scopeResult}
 private volatile String lastScope="";private volatile String lastLibrary;
 void page(){lastLibrary=generations();scopeResult();}
 void pauseResume(){catalog.foreground(false);catalog.foreground(true);handleOnResume();}
${resume}
 static void require(boolean value,String why){if(!value)throw new AssertionError(why);}
 public static void main(String[] args)throws Exception{
  ScopeVersionFixture f=new ScopeVersionFixture();
  String first=(String)f.scopeResult().get("version");require(!first.isEmpty(),"version published");
  f.pauseResume();require(f.refreshes==0,"no libraryChanged before a page");
  f.page();f.pauseResume();require(f.refreshes==0,"no libraryChanged without a row change");
  rows.put("external_primary",7L);f.pauseResume();
  require(f.refreshes==1,"a row changed while paused announces libraryChanged");
  f.pauseResume();require(f.refreshes==1,"the next resume stays quiet");
  require(f.announced.isEmpty(),"no scopeChanged without a change");
  require(first.equals(f.scopeResult().get("version")),"pause, resume and row edits keep the version");
  f.catalog.scope="selected";f.pauseResume();
  require(f.announced.size()==1&&!first.equals(f.announced.get(0).get("version")),"a changed grant announces a new version");
  String selected=(String)f.announced.get(0).get("version");
  f.catalog.versions.put("external_primary","v2");f.pauseResume();
  require(f.announced.size()==2&&!selected.equals(f.announced.get(1).get("version")),"a rebuilt volume announces a new version");
  f.catalog.versions.put("sdcard","s1");f.pauseResume();
  require(f.announced.size()==3,"a new volume announces a new version");
  f.page();f.pauseResume();require(f.announced.size()==3&&f.refreshes==1,"a resume after the reload stays quiet");
  System.out.println("PASS stable scope version");
 }
}`,
  );
  execFileSync(bin("javac"), ["-d", dir, file], { timeout: 60000 });
  assert.match(
    execFileSync(bin("java"), ["-cp", dir, "ScopeVersionFixture"], {
      encoding: "utf8",
      timeout: 60000,
    }),
    /PASS stable scope version/,
  );
});
