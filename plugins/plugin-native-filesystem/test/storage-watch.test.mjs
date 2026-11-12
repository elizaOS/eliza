import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
test("a refused storage watch releases only its current generation's resources", (t) => {
  const text = readFileSync(source, "utf8"),
    start = text.indexOf(" public static final class WatchSlot {");
  assert.ok(start >= 0);
  const slot = text.slice(start, text.lastIndexOf("}"));
  const classes = mkdtempSync(path.join(tmpdir(), "storage-watch-"));
  t.after(() => rmSync(classes, { recursive: true, force: true }));
  const file = path.join(classes, "StorageWatchFixture.java");
  writeFileSync(
    file,
    `public final class StorageWatchFixture {
${slot}
 static void require(boolean result,String reason){if(!result)throw new AssertionError(reason);}
 public static void main(String[] args){
  WatchSlot slot=new WatchSlot();int[] stops={0};
  long first=slot.request();require(slot.install(first,()->()->stops[0]++),"first watch installed");
  long refused=slot.request();slot.fail(refused);
  require(stops[0]==1&&!slot.active(),"a refused latest request releases previous resources");
  slot.fail(refused);require(stops[0]==1,"repeated refusal closes nothing twice");
  long stale=slot.request(),fresh=slot.request();
  require(slot.install(fresh,()->()->stops[0]++),"newer watch installed");
  slot.fail(stale);require(stops[0]==1&&slot.active()&&slot.isCurrent(fresh),"stale refusal preserves newer watch");
  long late=slot.request();slot.clear();slot.fail(late);
  require(stops[0]==2&&!slot.active(),"unwatch remains settled after a late refusal");
  require(!slot.install(late,()->{throw new AssertionError("retired request registered");}),"retired install refused");
  long throwing=slot.request();slot.install(throwing,()->()->{stops[0]++;throw new IllegalStateException("stop failed");});
  try{slot.fail(throwing);throw new AssertionError("cleanup failure hidden");}catch(IllegalStateException expected){}
  require(stops[0]==3&&!slot.active(),"failed cleanup loses publication authority");
  System.out.println("storage watch generations passed");
 }
}`,
  );
  execFileSync(bin("javac"), ["-d", classes, file], { timeout: 60000 });
  assert.match(
    execFileSync(bin("java"), ["-cp", classes, "StorageWatchFixture"], {
      encoding: "utf8",
      timeout: 60000,
    }),
    /storage watch generations passed/,
  );
});
