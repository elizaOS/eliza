import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(
  new URL(
    "../android/src/main/java/ai/eliza/plugins/filesystem/browser/StorageBrowser.java",
    import.meta.url,
  ),
);
/** @param {string} name */
const bin = (name) =>
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;

// JVM run of the real StorageBrowser over temporary folders. The two Android types it names are
// replaced by minimal stand-ins (no MIME table, no trash records here). Not Android evidence:
// no all-files access, FUSE mount or removable volume is involved.
const stubs = {
  "android/webkit/MimeTypeMap.java": `package android.webkit;
public class MimeTypeMap{private static final MimeTypeMap ONE=new MimeTypeMap();
 public static MimeTypeMap getSingleton(){return ONE;}
 public String getMimeTypeFromExtension(String ext){return null;}}`,
  "org/json/JSONObject.java": `package org.json;
public class JSONObject{public JSONObject(){} public JSONObject(String text){throw new UnsupportedOperationException();}
 public JSONObject put(String k,Object v){throw new UnsupportedOperationException();}
 public String optString(String k){return "";} public boolean optBoolean(String k){return false;} public long optLong(String k){return 0;}}`,
};
const fixture = `import ai.eliza.plugins.filesystem.browser.StorageBrowser;
import java.io.File;
import java.nio.file.Files;
import java.util.*;
public final class StorageBrowserFixture {
 static void require(boolean ok,String reason){if(!ok)throw new AssertionError(reason);}
 static File file(File root,String path,String text)throws Exception{File f=new File(root,path);f.getParentFile().mkdirs();Files.writeString(f.toPath(),text);return f;}
 static Map<String,StorageBrowser.Row> rows(List<StorageBrowser.Row> list){Map<String,StorageBrowser.Row> out=new TreeMap<>();for(StorageBrowser.Row r:list)out.put(r.path,r);return out;}
 public static void main(String[] args)throws Exception{
  File a=new File(args[0]),b=new File(args[1]);
  file(a,"Docs/a.txt","alpha");file(a,"Docs/.draft","x");file(a,".config/app.ini","k=v");file(a,".nomedia","");
  file(a,".trash/files/old","gone");file(a,"Docs/.trash/kept.txt","nested");new File(a,"Docs/.hidden-dir/deep").mkdirs();
  StorageBrowser browser=new StorageBrowser(a,".trash");

  Map<String,StorageBrowser.Row> plain=rows(browser.list(""));
  require(plain.keySet().equals(Set.of("Docs")),"the default listing hides dot entries and the trash: "+plain.keySet());
  require(plain.get("Docs").children==1,"the default child count skips dot entries");
  Map<String,StorageBrowser.Row> all=rows(browser.list("",true));
  require(all.keySet().equals(Set.of("Docs",".config",".nomedia")),"hidden entries are listed, never the trash: "+all.keySet());
  require(all.get("Docs").children==4,"the hidden child count includes dot entries");
  require(rows(browser.list("Docs",true)).containsKey("Docs/.trash"),"a nested folder named like the trash is an ordinary folder");
  require(rows(browser.list(".config",false)).containsKey(".config/app.ini"),"a hidden folder opened by path lists its children");

  Set<String> walked=rows(browser.folders("",null,0,0,100,100)).keySet();
  require(walked.equals(Set.of("Docs")),"the default walk skips hidden folders: "+walked);
  walked=rows(browser.folders("",null,0,0,100,100,true)).keySet();
  require(walked.equals(Set.of("Docs",".config","Docs/.trash","Docs/.hidden-dir","Docs/.hidden-dir/deep")),"the hidden walk enters dot folders, never the trash: "+walked);

  // Another volume: a copy keeps the source, a move removes it, and outcomes name the target volume.
  StorageBrowser other=new StorageBrowser(b,".trash");new File(b,"In").mkdirs();file(b,"In/a.txt","clash");
  List<StorageBrowser.Outcome> copied=browser.transfer(List.of("Docs/a.txt","Docs"),other,"In",true,null);
  require(copied.get(0).status.equals("copied")&&copied.get(0).to.equals("In/a (1).txt"),"a cross-volume copy keeps both on a clash");
  require(copied.get(1).status.equals("copied")&&copied.get(1).to.equals("In/Docs"),"a folder copies to the other volume");
  require(Files.readString(new File(b,"In/Docs/.trash/kept.txt").toPath()).equals("nested"),"a folder copy includes hidden children");
  require(new File(a,"Docs/a.txt").isFile(),"a copy keeps its source");
  List<StorageBrowser.Outcome> moved=browser.transfer(List.of(".config"),other,"",false,null);
  require(moved.get(0).status.equals("moved")&&moved.get(0).to.equals(".config"),"a cross-volume move names the target path");
  require(!new File(a,".config").exists()&&Files.readString(new File(b,".config/app.ini").toPath()).equals("k=v"),"a cross-volume move removes the source after the copy");
  try{browser.transfer(List.of("Docs/a.txt"),other,".trash",true,null);throw new AssertionError("the other volume's trash was accepted");}
  catch(IllegalArgumentException expected){}
  // A copy that fails part way is removed again on the volume it was copied to.
  file(a,"Tree/ok.txt","ok");Files.createSymbolicLink(new File(a,"Tree/link").toPath(),new File(a,"Docs/a.txt").toPath());
  List<StorageBrowser.Outcome> partial=browser.transfer(List.of("Tree"),other,"",true,null);
  require(partial.get(0).status.equals("failed"),"a copy with a linked child fails");
  require(!new File(b,"Tree").exists(),"the partial copy is removed from the other volume");

  // Shared storage ignores case: a root folder spelled like the trash in another case is the trash.
  File c=new File(args[2]);file(c,".TRASH/files/old","gone");file(c,".seen","x");
  Set<String> cased=rows(new StorageBrowser(c,".trash").list("",true)).keySet();
  require(cased.equals(Set.of(".seen")),"the trash is never listed whatever its case: "+cased);
  System.out.println("storage browser passed");
 }
}`;

test("hidden entries are opt-in and transfers can name another volume", (t) => {
  const work = mkdtempSync(path.join(tmpdir(), "storage-browser-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const sources = path.join(work, "src"),
    classes = path.join(work, "classes"),
    a = path.join(work, "volume-a"),
    b = path.join(work, "volume-b"),
    c = path.join(work, "volume-c");
  for (const [name, text] of Object.entries(stubs)) {
    mkdirSync(path.dirname(path.join(sources, name)), { recursive: true });
    writeFileSync(path.join(sources, name), text);
  }
  writeFileSync(path.join(sources, "StorageBrowserFixture.java"), fixture);
  mkdirSync(a);
  mkdirSync(b);
  mkdirSync(c);
  execFileSync(
    bin("javac"),
    [
      "-d",
      classes,
      source,
      ...Object.keys(stubs).map((name) => path.join(sources, name)),
      path.join(sources, "StorageBrowserFixture.java"),
    ],
    { timeout: 60000 },
  );
  assert.match(
    execFileSync(bin("java"), ["-cp", classes, "StorageBrowserFixture", a, b, c], {
      encoding: "utf8",
      timeout: 60000,
    }),
    /storage browser passed/,
  );
});
