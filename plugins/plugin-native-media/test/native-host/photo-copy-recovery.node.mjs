import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(
  new URL(
    "../../android/src/main/java/ai/eliza/plugins/media/OwnedPhotoEdits.java",
    import.meta.url,
  ),
);
/** @param {string} name */
const bin = (name) =>
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;
test("photo-copy recovery observes pending rows and confirms cleanup before failure", (t) => {
  const text = readFileSync(source, "utf8"),
    start = text.indexOf("  public JSObject result(String token)");
  const end = text.indexOf("  public JSObject save(", start);
  assert.ok(start >= 0 && end > start);
  const classes = mkdtempSync(path.join(tmpdir(), "photo-copy-recovery-"));
  t.after(() => rmSync(classes, { recursive: true, force: true }));
  const file = path.join(classes, "PhotoCopyRecoveryFixture.java");
  writeFileSync(
    file,
    `import java.util.*;import java.io.IOException;
public final class PhotoCopyRecoveryFixture {
 static class JSONObject extends HashMap<String,Object>{static final Map<String,Map<String,Object>> values=new HashMap<>();JSONObject(){}JSONObject(String value){putAll(values.get(value));}public JSONObject put(String k,Object v){super.put(k,v);return this;}boolean optBoolean(String k){return Boolean.TRUE.equals(get(k));}String optString(String k){return optString(k,"");}String optString(String k,String fallback){return get(k) instanceof String?(String)get(k):fallback;}public String toString(){String id="json:"+UUID.randomUUID();values.put(id,new HashMap<>(this));return id;}}
 static class JSObject extends JSONObject{}
 static class Uri{final long id;final boolean pending;Uri(long id,boolean pending){this.id=id;this.pending=pending;}}
 static class MediaStore{static class Images{static class Media{static final Uri EXTERNAL_CONTENT_URI=new Uri(0,false);}}static Uri setIncludePending(Uri uri){return new Uri(uri.id,true);}}
 static class ContentUris{static Uri withAppendedId(Uri base,long id){return new Uri(id,false);}static long parseId(Uri uri){return uri.id;}}
 static class Cursor implements AutoCloseable{final int count,pending;int at;Cursor(int count,int pending){this.count=count;this.pending=pending;}boolean moveToFirst(){at=0;return count>0;}boolean moveToNext(){return ++at<count;}long getLong(int col){return 7;}int getInt(int col){return pending;}public void close(){}}
 final Context context=new Context();static class Context{String getPackageName(){return "example.test";}}
 final Journal journal=new Journal();static class Journal{String record;String getString(String key,String fallback){return record;}Journal edit(){return this;}Journal putString(String key,String value){record=value;return this;}boolean commit(){return true;}}
 boolean pending=true,present=true,unavailable=false,ambiguous=false,cleanupFails=false;int deletes;
 final Resolver resolver=new Resolver();class Resolver{
  Cursor query(Uri uri,String[] columns,String where,String[] args,Object sort){if(unavailable)return null;if(!where.equals("owner_package_name=? AND _display_name=?")||!Arrays.equals(args,new String[]{"example.test","copy-token"}))throw new AssertionError("lookup authority changed");return new Cursor(present&&(!pending||uri.pending)?ambiguous?2:1:0,pending?1:0);}
  int delete(Uri uri,String where,Object args){deletes++;if(uri.id!=7||!where.equals("is_pending=1"))throw new AssertionError("cleanup authority changed");if(cleanupFails||!present||!pending||!uri.pending)return 0;present=false;return 1;}
 }
 String name(String token){return "copy-token";}Uri source(String id){return new Uri(Long.parseLong(id),false);}JSObject replaceResult(String token,JSONObject record){throw new AssertionError("copy recovery entered Replace");}
 JSObject receipt(String state,String token,Uri uri){JSObject out=new JSObject();out.put("status",state);if(uri!=null)out.put("id",Long.toString(uri.id));return out;}
${text.slice(start, end)}
 static PhotoCopyRecoveryFixture fixture(String receipt){PhotoCopyRecoveryFixture f=new PhotoCopyRecoveryFixture();f.journal.record=new JSONObject().put("status",receipt).toString();return f;}
 static void require(boolean result,String reason){if(!result)throw new AssertionError(reason);}
 static void unconfirmed(PhotoCopyRecoveryFixture f)throws Exception{try{f.result("token");throw new AssertionError("unconfirmed cleanup reported terminal");}catch(IOException|IllegalStateException expected){}require(new JSONObject(f.journal.record).optString("status").equals("writing"),"receipt remains unsettled");}
 public static void main(String[] args)throws Exception{
  PhotoCopyRecoveryFixture pending=fixture("writing");require(pending.result("token").optString("status").equals("failed"),"pending copy settles failure");require(!pending.present&&pending.deletes==1,"pending copy removed");pending.result("token");require(pending.deletes==1,"retry never deletes another item");
  PhotoCopyRecoveryFixture published=fixture("writing");published.pending=false;require(published.result("token").optString("status").equals("saved")&&published.deletes==0&&published.present,"published copy reused");
  PhotoCopyRecoveryFixture historic=fixture("saved");require(historic.result("token").optString("status").equals("saved")&&historic.deletes==0&&historic.present,"historical success is never deleted");
  PhotoCopyRecoveryFixture absent=fixture("writing");absent.present=false;require(absent.result("token").optString("status").equals("failed")&&absent.deletes==0,"absent copy is not recreated");
  PhotoCopyRecoveryFixture failed=fixture("writing");failed.cleanupFails=true;unconfirmed(failed);require(failed.present,"unconfirmed deletion retains row");
  PhotoCopyRecoveryFixture unavailable=fixture("writing");unavailable.unavailable=true;unconfirmed(unavailable);require(unavailable.deletes==0,"unavailable lookup never deletes");
  PhotoCopyRecoveryFixture ambiguous=fixture("writing");ambiguous.ambiguous=true;unconfirmed(ambiguous);require(ambiguous.deletes==0,"ambiguous identity never deletes");
  System.out.println("photo-copy recovery passed");
 }
}`,
  );
  execFileSync(bin("javac"), ["-d", classes, file], { timeout: 60000 });
  assert.match(
    execFileSync(bin("java"), ["-cp", classes, "PhotoCopyRecoveryFixture"], {
      encoding: "utf8",
      timeout: 60000,
    }),
    /photo-copy recovery passed/,
  );
});
