import assert from "node:assert/strict";
import test from "node:test";
import {
  appStoreRuntimeBuildSettingsText,
  findForbiddenRuntimeImportGroups,
  findForbiddenRuntimeStrings,
  formatForbiddenRuntimeFindings,
} from "./ios-app-store-runtime-policy.mjs";

test("groups exact and family forbidden runtime imports", () => {
  const groups = findForbiddenRuntimeImportGroups(`
                 U _dlopen
                 U _dlsym
                 U _posix_spawn
                 U _posix_spawn_file_actions_addopen
                 U _posix_spawnp
                 U _pthread_atfork
                 U _vm_protect
                 U _objc_msgSend
  `);

  assert.deepEqual(
    groups.map((group) => group.label),
    [
      "dynamic loader / native extension loading",
      "process spawning / helper executables",
      "writable executable memory / JIT permissions",
    ],
  );
  assert.deepEqual(groups[1].symbols, [
    "_posix_spawn",
    "_posix_spawn_file_actions_addopen",
    "_posix_spawnp",
    "_pthread_atfork",
  ]);
});

test("detects executable-memory string markers", () => {
  assert.deepEqual(findForbiddenRuntimeStrings("uses MAP_JIT when available"), [
    "\\bMAP_JIT\\b",
  ]);
});

test("formats remediation with build settings", () => {
  const text = formatForbiddenRuntimeFindings({
    binary: "/tmp/ElizaBunEngine",
    importGroups: findForbiddenRuntimeImportGroups("U _fork\nU _execve\n"),
  });

  assert.match(text, /ELIZA_IOS_DISABLE_PROCESS_SPAWN=1/);
  assert.match(text, /-DENABLE_BUN_SUBPROCESS=OFF/);
  assert.match(appStoreRuntimeBuildSettingsText(), /ELIZA_IOS_NO_JIT=1/);
});
