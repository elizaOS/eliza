import assert from "node:assert/strict";
import { test } from "node:test";
import {
  androidFixtureObserver,
  androidPreferenceString,
} from "./android-fixture-observation.mjs";

test("preference selection decodes XML once and ignores unrelated records", () => {
  const xml =
    '<map><string name="other">private neighbor</string><string name="fixture.id">&quot;&amp;lt;&lt;&gt;&apos;&#10;&#x1f642;</string></map>';
  assert.equal(androidPreferenceString(xml, "fixture.id"), "\"&lt;<>'\n🙂");
  assert.equal(androidPreferenceString(xml, "missing"), null);
  assert.equal(
    androidPreferenceString(
      '<map><string name="empty"></string></map>',
      "empty",
    ),
    "",
  );
});
for (const value of [
  "&unknown;",
  "&bare",
  "&#0;",
  "&#xD800;",
  "&#x110000;",
  "<nested/>",
])
  test(`preference string refuses malformed selected data: ${value}`, () => {
    assert.throws(() =>
      androidPreferenceString(
        `<map><string name="id">${value}</string></map>`,
        "id",
      ),
    );
  });
test("duplicate selected keys are not first-match evidence", () => {
  assert.throws(
    () =>
      androidPreferenceString(
        '<map><string name="id">a</string><string name="id">b</string></map>',
        "id",
      ),
    /Ambiguous/,
  );
});

test("observer scopes preferences, stopped state and notification identity to the fixture user", async () => {
  const calls = [];
  const observer = androidFixtureObserver({
    packageName: "org.example.fixture",
    androidUser: 10,
    run: async (...args) => {
      calls.push(args);
      if (args.includes("run-as"))
        return '<map><string name="envelope">{&quot;records&quot;:{}}</string></map>';
      if (args.includes("dumpsys"))
        return "Packages:\n  Package [org.example.fixture] (abc):\n    User 0: stopped=true\n    User 10: installed=true stopped=false\n    User 11: stopped=true\nQueries:\n    User 10:";
      if (args.includes("notification"))
        return "0|org.example.fixture|0|owned|10001\n10|org.other|0|owned|10002\n10|org.example.fixture|1|owned|1010001\n10|org.example.fixture|0|different|1010001";
      throw Error("Unexpected command");
    },
  });
  assert.equal(
    await observer.preferenceString("fixture-envelope-v1", "envelope"),
    '{"records":{}}',
  );
  assert.deepEqual(calls[0], [
    "shell",
    "run-as",
    "org.example.fixture",
    "--user",
    "10",
    "cat",
    "shared_prefs/fixture-envelope-v1.xml",
  ]);
  assert.equal(await observer.stopped(), false);
  assert.equal(await observer.notification({ id: 0, tag: "owned" }), false);
  assert.ok(
    calls.every(
      (args) =>
        !args.includes("instrument") &&
        !args.includes("start") &&
        !args.includes("force-stop"),
    ),
  );
});
test("exact user/package/ID/tag key proves notification presence", async () => {
  const observer = androidFixtureObserver({
    packageName: "org.example.fixture",
    androidUser: 10,
    run: async () => "10|org.example.fixture|0|owned|1010001\r\n",
  });
  assert.equal(await observer.notification({ id: 0, tag: "owned" }), true);
});
for (const dump of [
  "User 0: stopped=false",
  "User 10: installed=true",
  "User 10: stopped=false\nUser 10: stopped=true",
])
  test(`missing or ambiguous stopped state fails: ${dump}`, async () => {
    const observer = androidFixtureObserver({
      packageName: "org.example.fixture",
      androidUser: 10,
      run: async () =>
        "Packages:\n  Package [org.example.fixture] (abc):\n" +
        dump
          .split("\n")
          .map((line) => `    ${line}`)
          .join("\n"),
    });
    await assert.rejects(observer.stopped());
  });
test("unsafe selectors and owner user are refused before ADB", async () => {
  const run = async () => {
    throw Error("ADB must not run");
  };
  assert.throws(
    () =>
      androidFixtureObserver({
        run,
        packageName: "org.example.fixture",
        androidUser: 0,
      }),
    /fixture user/,
  );
  const observer = androidFixtureObserver({
    run,
    packageName: "org.example.fixture",
    androidUser: 10,
  });
  await assert.rejects(observer.preferenceString("../other", "id"), {
    code: "ERR_ASSERTION",
  });
  await assert.rejects(observer.preferenceString("fixture", 'id"'), {
    code: "ERR_ASSERTION",
  });
  await assert.rejects(
    observer.notification({ id: 0, tag: "owned|other" }),
    /tag/,
  );
});
test("transport errors remain observation failures", async () => {
  const error = Error("fixture unavailable");
  const observer = androidFixtureObserver({
    packageName: "org.example.fixture",
    androidUser: 10,
    run: async () => {
      throw error;
    },
  });
  for (const observe of [
    () => observer.stopped(),
    () => observer.notification({ id: 0, tag: "owned" }),
    () => observer.preferenceString("fixture", "id"),
  ])
    await assert.rejects(observe(), (value) => value === error);
});

test("partial XML cannot prove a persisted preference", () => {
  assert.throws(
    () =>
      androidPreferenceString('<map><string name="id">posted</string>', "id"),
    /Complete/,
  );
  assert.throws(
    () =>
      androidPreferenceString(
        '<map><!-- <string name="id">posted</string> --></map>',
        "id",
      ),
    /Unsupported/,
  );
  assert.equal(
    androidPreferenceString(
      '<?xml version="1.0" encoding="utf-8" standalone="yes" ?>\n<map><string name="id">posted</string></map>\n',
      "id",
    ),
    "posted",
  );
});

test("incomplete notification keys are not receipt evidence", async () => {
  for (const key of [
    "10|org.example.fixture|0|owned",
    "10|org.example.fixture|0|owned|unknown",
  ]) {
    const observer = androidFixtureObserver({
      packageName: "org.example.fixture",
      androidUser: 10,
      run: async () => key,
    });
    assert.equal(await observer.notification({ id: 0, tag: "owned" }), false);
  }
});

// Reduced from an API 35 dumpsys package capture. Queries repeats User headings.
test("package state excludes query visibility and similarly named packages", async () => {
  const dump = `Packages:
  Package [org.example.fixture.test] (def):
    User 10: ceDataInode=492156 installed=true stopped=true
  Package [org.example.fixture] (abc):
    User 0: ceDataInode=0 installed=false stopped=true
    User 10: ceDataInode=492156 installed=true stopped=false
      installReason=0
      runtime permissions:
        android.permission.POST_NOTIFICATIONS: granted=true
  Package [org.example.fixture.other] (fed):
    User 10: installed=true stopped=true
Queries:
  queryable via interaction:
    User 0:
    User 10:
Dexopt state:
  [org.example.fixture]
`;
  const observer = androidFixtureObserver({
    packageName: "org.example.fixture",
    androidUser: 10,
    run: async () => dump,
  });
  assert.equal(await observer.stopped(), false);
});
for (const dump of [
  "Packages:\n  Package [org.example.fixture.test] (def):\n    User 10: stopped=false",
  "Packages:\n  Package [org.example.fixture] (abc):\n    User 10: stopped=false\n  Package [org.example.fixture] (def):\n    User 10: stopped=false",
  "Packages:\n  Package [org.example.fixture] (abc):\nQueries:\n    User 10: stopped=false",
  "    User 10: stopped=false",
])
  test(`unidentified or ambiguous package inventory fails: ${dump}`, async () => {
    const observer = androidFixtureObserver({
      packageName: "org.example.fixture",
      androidUser: 10,
      run: async () => dump,
    });
    await assert.rejects(observer.stopped());
  });
