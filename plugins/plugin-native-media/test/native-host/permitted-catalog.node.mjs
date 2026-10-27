import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const plugin = fileURLToPath(new URL("../..", import.meta.url));
const media = path.join(plugin, "android/src/main/java/ai/eliza/plugins/media");
/** @param {string} name */
const bin = (name) =>
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;
/** @param {string} name */
const source = (name) =>
  fs.readFileSync(path.join(media, `${name}.java`), "utf8");
/** Whitespace-insensitive form, so checks follow the code rather than its line breaks. */
/** @param {string} text */
const compact = (text) => text.replace(/\s+/g, "");
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

// Runs the production method on a host JVM with a synthetic ContentResolver. This is not Android
// acceptance: it checks dispatch and readback rules without deleting real media.
test("permitted permanent deletion fences restored or changed items and requires exact absence", (t) => {
  const method = between(
    source("PermittedMediaCatalog"),
    "  public JSObject deleteTrashed(",
    "  @Override\n  public void close()",
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "permitted-trash-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "PermittedTrashFixture.java");
  fs.writeFileSync(
    file,
    `import java.util.*;
public class PermittedTrashFixture {
 static class Build{static class VERSION{static int SDK_INT=30;}}
 static class JSObject extends HashMap<String,Object>{String getString(String key){return (String)get(key);}Boolean getBoolean(String key){return (Boolean)get(key);}}
 static class Bundle extends HashMap<String,Object>{Bundle(){}Bundle(Bundle before){super(before);}void putInt(String key,int value){put(key,value);}void putString(String key,String value){put(key,value);}void putStringArray(String key,String[] value){put(key,value);}}
 static class MediaStore{static final String QUERY_ARG_MATCH_TRASHED="trash";static final int MATCH_ONLY=1,MATCH_INCLUDE=2;}
 static class ContentResolver{static final String QUERY_ARG_SQL_SELECTION="where",QUERY_ARG_SQL_SELECTION_ARGS="args";}
 static class MediaLibraryKey{long id=7;String volume="external_primary";boolean video;static MediaLibraryKey parse(String id){if(!id.equals("m:external_primary:i:7"))throw new IllegalArgumentException();return new MediaLibraryKey();}}
 static class Cursor implements AutoCloseable{boolean present;Cursor(boolean present){this.present=present;}boolean moveToFirst(){return present;}long getLong(int index){return index==9?10:2;}public void close(){}}
 boolean exists=true,trashed=true,changed=false,failedReadback=false;int deletes=0,reads=0;String providerRevision="r1";
 JSObject mutationSource(String id,String revision){if(!exists||!revision.equals(providerRevision))throw new IllegalStateException("stale");JSObject row=new JSObject();row.put("trashed",trashed);return row;}
 String revision(Cursor row,String volume){return providerRevision;}
 void unlocked(){}
 Object uri(MediaLibraryKey key){return key;}
 void invalidate(){}
 Cursor query(String volume,boolean video,Bundle query){reads++;if(deletes>0&&failedReadback)return null;return new Cursor(exists);}
 final Resolver resolver=new Resolver();
 class Resolver{int delete(Object uri,Bundle query){deletes++;String sql=(String)query.get("where");String[] args=(String[])query.get("args");
  if(!sql.equals("_id=? AND is_pending=0 AND is_trashed=1 AND generation_modified=? AND generation_added=?"))throw new AssertionError("missing atomic fence");
  if(!Arrays.equals(args,new String[]{"7","10","2"}))throw new AssertionError("wrong generation binding");
  if(!trashed||changed)return 0;exists=false;return 1;}}
${method}
 static void require(boolean value){if(!value)throw new AssertionError();}
 static void refused(PermittedTrashFixture f,String revision)throws Exception{try{f.deleteTrashed("m:external_primary:i:7",revision);throw new AssertionError("unexpected deletion success");}catch(IllegalStateException expected){}}
 public static void main(String[] args)throws Exception{
  Build.VERSION.SDK_INT=29;PermittedTrashFixture old=new PermittedTrashFixture();try{old.deleteTrashed("m:external_primary:i:7","r1");throw new AssertionError("unsupported API accepted");}catch(UnsupportedOperationException expected){}require(old.deletes==0&&old.reads==0&&old.exists);Build.VERSION.SDK_INT=30;
  PermittedTrashFixture ok=new PermittedTrashFixture();require(ok.deleteTrashed("m:external_primary:i:7","r1").getString("status").equals("deleted"));require(!ok.exists&&ok.deletes==1&&ok.reads==2);
  PermittedTrashFixture restored=new PermittedTrashFixture();restored.trashed=false;refused(restored,"r1");require(restored.deletes==0&&restored.exists);
  PermittedTrashFixture stale=new PermittedTrashFixture();refused(stale,"old");require(stale.deletes==0&&stale.exists);
  PermittedTrashFixture raced=new PermittedTrashFixture();raced.changed=true;refused(raced,"r1");require(raced.exists);
  PermittedTrashFixture unknown=new PermittedTrashFixture();unknown.failedReadback=true;refused(unknown,"r1");require(unknown.deletes==1&&!unknown.exists);
  System.out.println("PASS exact-revision trash deletion");
 }
}`,
  );
  execFileSync(bin("javac"), ["-d", dir, file], { timeout: 60000 });
  assert.match(
    execFileSync(bin("java"), ["-cp", dir, "PermittedTrashFixture"], {
      encoding: "utf8",
      timeout: 60000,
    }),
    /PASS exact-revision trash deletion/,
  );
});

test("library reads publish only under the read ticket they were admitted with", () => {
  const catalog = compact(source("PermittedMediaCatalog"));
  assert.ok(
    catalog.includes(
      compact(
        "main.post(() -> { try { requireReadTicket(ticket); call.resolve(value);",
      ),
    ),
    "a completed read is delivered on the main thread only if access did not change",
  );
  assert.ok(
    catalog.includes("checkReadAccess();"),
    "every ticket rechecks granted scope",
  );
  assert.ok(
    catalog.includes("ACTION_SCREEN_OFF"),
    "screen off invalidates outstanding reads",
  );
  assert.ok(
    catalog.includes(
      compact(
        '"_id=? AND is_pending=0 AND generation_modified=? AND generation_added=? AND "',
      ),
    ),
    "favorite and trash changes carry an atomic generation fence",
  );
  assert.ok(catalog.includes(compact('" AND date_added>=?"')));
  assert.ok(catalog.includes(compact('" AND date_added<=?"')));
  assert.ok(
    catalog.includes(
      compact(
        "public Map<String, JSObject> albumItems(List<String[]> members)",
      ),
    ),
  );
  assert.ok(
    catalog.includes(compact('" AND _id IN ("')),
    "album members are read in batches",
  );
});

test("an approved write request is applied only after the activity resumes", () => {
  const review = source("PermittedMediaReview");
  const flat = compact(review);
  assert.ok(flat.includes("afterResume(request);"));
  assert.ok(
    flat.includes(
      compact(
        "if (lifecycle.getCurrentState().isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)) { dispatch(request); return; }",
      ),
    ),
  );
  assert.ok(
    flat.includes("event==androidx.lifecycle.Lifecycle.Event.ON_RESUME"),
  );
  const launcher = between(
    review,
    "launcher = bridge.registerForActivityResult",
    "  private void afterResume(",
  );
  assert.doesNotMatch(
    launcher,
    /worker\.execute/,
    "the result callback never dispatches before resume",
  );
  for (const code of ["DECLINED", "STALE"])
    assert.match(
      review,
      new RegExp(`, ${code}\\)`),
      `${code} rejections carry their code`,
    );
  assert.ok(
    flat.includes(compact("if (!gate.ask(call, () -> launcher.launch(")),
  );
});
