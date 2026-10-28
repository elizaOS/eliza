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

test("folder session bounds, eviction, cursors and names", (t) => {
  const classes = fs.mkdtempSync(path.join(os.tmpdir(), "folder-session-"));
  t.after(() => fs.rmSync(classes, { recursive: true, force: true }));
  execFileSync(
    bin("javac"),
    [
      "-d",
      classes,
      path.join(media, "FolderSession.java"),
      path.join(plugin, "test/native-host/FolderSessionTest.java"),
    ],
    { timeout: 60000 },
  );
  const out = execFileSync(
    bin("java"),
    ["-cp", classes, "ai.eliza.plugins.media.FolderSessionTest"],
    { timeout: 60000, encoding: "utf8" },
  );
  assert.match(out, /folder session checks: \d+/);
});

// Source checks of the Android engine's order of checks. Not Android evidence: no provider or
// grant has been used here.
test("folder changes are revision-checked, confirmed and never broaden access", () => {
  const tree = source("DocumentFolderTree");
  const flat = compact(tree);
  assert.ok(
    !/READ_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE|Uri\.fromFile|getExternalStorage/.test(
      tree,
    ),
    "no broad storage access or file-path authority",
  );
  assert.ok(
    flat.includes(
      compact(
        'catch (SecurityException revoked) { session.clear(); return result("revoked",',
      ),
    ),
    "revoked access forgets every capability",
  );
  const remove = compact(
    between(tree, "public JSObject delete(", "public JSObject move("),
  );
  const order = [
    'if(!info.optBoolean("canDelete"))',
    "if(!confirmPermanent)",
    "if(!current(info,expectedRevision))",
    'list(item);if(contents.getJSONArray("entries").length()>0)',
    "DocumentsContract.deleteDocument(",
  ].map((step) => remove.indexOf(step));
  assert.ok(
    order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])),
    "capability, confirmation, revision and emptiness are checked before deletion",
  );
  const batch = compact(
    between(tree, "public JSObject changeMany(", "public JSObject shareMany("),
  );
  assert.ok(
    batch.indexOf("if(!move&&!confirmPermanent)") <
      batch.indexOf("DocumentsContract.deleteDocument("),
  );
  assert.ok(
    batch.indexOf("if(!current(info,expected))") <
      batch.indexOf("DocumentsContract.moveDocument("),
  );
  assert.ok(
    batch.includes('expired=true;outcomes.put(outcome(id,"revoked"'),
    "access ending mid-batch reports the items already changed",
  );
  const adopt = compact(
    between(tree, "public JSObject adopt(", "private void release("),
  );
  assert.ok(
    adopt.indexOf("takePersistableUriPermission(") <
      adopt.indexOf(".putString(KEY,uri.toString()).commit()") &&
      adopt.indexOf(".putString(KEY,uri.toString()).commit()") <
        adopt.indexOf("release(previous)"),
    "the new grant is persisted and recorded before the previous tree is released",
  );
  const share = compact(
    between(
      tree,
      "public JSObject shareMany(",
      "public JSObject createFolder(",
    ),
  );
  assert.ok(share.includes("Nothinghasbeensentyet."));
  assert.ok(
    share.indexOf("if(!current(info,") < share.indexOf("uris.add("),
    "only unchanged listed files are shared",
  );
});
