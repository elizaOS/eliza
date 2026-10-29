import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const media = fileURLToPath(
  new URL(
    "../../android/src/main/java/ai/eliza/plugins/media/",
    import.meta.url,
  ),
);
/** @param {string} name */
const source = (name) =>
  fs.readFileSync(path.join(media, `${name}.java`), "utf8");
/** @param {string} text */
const compact = (text) => text.replace(/\s+/g, "");

// Source checks of where reference counting is applied. Not Android evidence: no provider grant
// has been held or released on a device here.
test("forgetting or evicting a picker selection never releases a grant a saved link names", () => {
  const documents = source("SelectedDocuments");
  const flat = compact(documents);
  assert.ok(
    flat.includes(
      compact(
        "private void releaseUnused(Uri uri, int flags) { if (uri == null || flags == 0 || selected.containsValue(uri) || referencedBySavedItem(uri)) return;",
      ),
    ),
  );
  const release = compact(
    documents.slice(
      documents.indexOf("public synchronized boolean releaseUnreferenced("),
      documents.indexOf("public synchronized void forget("),
    ),
  );
  assert.ok(
    release.includes(
      "selected.containsValue(uri)||referencedBySavedItem(uri))returnfalse;",
    ),
  );
  assert.ok(
    release.includes("if(!grant.getUri().equals(uri))continue;"),
    "only the exact document grant, never a covering tree grant",
  );
});

test("source references store a grace time before the reference and reconcile before pruning", () => {
  const store = compact(source("SourceReferenceStore"));
  assert.ok(
    store.includes(
      compact(
        "if (!retained().edit().putLong(reference, now).commit() || !refs.edit().putString(reference, uri.toString()).commit())",
      ),
    ),
    "every retain (re)starts a stored grace period before the reference is written",
  );
  const seed = store.indexOf(
    "SourceReferences.unseeded(all,times.getAll(),now)",
  );
  const prune = store.indexOf(
    "SourceReferences.unreferenced(all,keep,times.getAll(),now,grace)",
  );
  assert.ok(
    seed > 0 && prune > seed,
    "retain times are seeded before anything is pruned",
  );
  assert.ok(store.includes("SourceReferences.orphaned(all,drop)"));
  assert.ok(
    store.includes("persistedReadAccess(context.getContentResolver(),uri)"),
  );
});
