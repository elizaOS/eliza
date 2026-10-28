import assert from "node:assert/strict";
import { test } from "node:test";

const {
  createLauncher,
  filterLauncherApps,
  describeLauncherApps: sharedDescribe,
  appKey,
  localFavorites: sharedLocalFavorites,
  MAX_FAVORITES,
} = await import("../src/client/launcher.ts");

const describeLauncherApps = (apps) =>
  sharedDescribe(apps, { productName: "Alpha Phone", builtinPrefix: "alpha:" });
const FAVORITES_KEY = "alpha.launcher.favorites.v1";
const localFavorites = (storage) =>
  sharedLocalFavorites(storage, {
    key: FAVORITES_KEY,
    defaultPolicy: "alpha-apps",
  });

const icon = "data:image/png;base64,iVBORw0KGgo=";
const apps = [
  { packageName: "com.android.settings", label: "Settings", icon },
  { packageName: "org.example.camera", label: "Caméra" },
  { packageName: "com.android.chrome", label: "Chrome" },
  { packageName: "com.example.reset", label: "Reset tools" },
];
/** Native DeviceApps stub: records every call, never touches a device. */
function stub(overrides = {}) {
  const calls = [];
  const bridge = {
    list: async (options) => {
      calls.push(["list", options]);
      return { apps };
    },
    launch: async (input) => {
      calls.push(["launch", input.packageName]);
    },
    resolveDefault: async (input) => {
      calls.push(["resolveDefault", input.role]);
      return {
        role: "dial",
        available: true,
        packageName: "com.android.dialer",
        label: "Phone",
      };
    },
    openDefault: async (input) => {
      calls.push(["openDefault", input.role]);
    },
    ...overrides,
  };
  let changes = 0;
  const launcher = createLauncher(bridge, () => changes++, { icons: true });
  return { launcher, calls, changes: () => changes };
}

test("search matches labels ignoring case and accents, prefix first, then package names", () => {
  assert.deepEqual(
    filterLauncherApps(apps, "").map((a) => a.label),
    ["Caméra", "Chrome", "Reset tools", "Settings"],
  );
  assert.deepEqual(
    filterLauncherApps(apps, "set").map((a) => a.label),
    ["Settings", "Reset tools"],
  );
  assert.deepEqual(
    filterLauncherApps(apps, "CAMERA").map((a) => a.label),
    ["Caméra"],
  );
  assert.deepEqual(
    filterLauncherApps(apps, "android").map((a) => a.label),
    ["Chrome", "Settings"],
  );
  assert.deepEqual(filterLauncherApps(apps, "zzz"), []);
});
test("opening reads apps with icons and the dial handler, and launches only on an explicit tap", async () => {
  const { launcher, calls } = stub();
  await launcher.load();
  const snap = launcher.snapshot();
  assert.equal(snap.status, "ready");
  assert.equal(snap.apps.length, 4);
  assert.equal(snap.dial.packageName, "com.android.dialer");
  assert.deepEqual(calls, [
    ["list", { icons: true }],
    ["resolveDefault", "dial"],
  ]);
  await launcher.launch(snap.apps[0]);
  await launcher.openDial();
  assert.deepEqual(calls.slice(2), [
    ["launch", "com.android.settings"],
    ["openDefault", "dial"],
  ]);
});
test("an empty device list is a ready empty state, not a failure", async () => {
  const { launcher } = stub({ list: async () => ({ apps: [] }) });
  await launcher.load();
  assert.equal(launcher.snapshot().status, "ready");
  assert.deepEqual(launcher.snapshot().apps, []);
});
test("a failed or malformed list is an explicit failure and is never retried automatically", async () => {
  for (const list of [
    async () => {
      throw Error("Bridge down");
    },
    async () => ({ apps: "nope" }),
  ]) {
    let reads = 0;
    const { launcher } = stub({
      list: async () => {
        reads++;
        return list();
      },
    });
    await launcher.load();
    assert.equal(launcher.snapshot().status, "failed");
    assert.equal(reads, 1);
  }
});
test("invalid entries, duplicate packages and non-PNG icons are dropped", async () => {
  const { launcher } = stub({
    list: async () => ({
      apps: [
        apps[0],
        apps[0],
        { label: "No package" },
        { packageName: "x.y", label: "Bad icon", icon: "javascript:alert(1)" },
        { packageName: "p.q", label: 7 },
      ],
    }),
  });
  await launcher.load();
  assert.deepEqual(
    launcher.snapshot().apps.map((a) => a.packageName),
    ["com.android.settings"],
  );
});
test("a missing dialer or a platform without default resolution hides the Phone shortcut", async () => {
  for (const resolveDefault of [
    async () => ({ role: "dial", available: false }),
    async () => {
      throw Error("not implemented");
    },
    undefined,
  ]) {
    const { launcher } = stub({ resolveDefault });
    await launcher.load();
    assert.equal(launcher.snapshot().dial, null);
    assert.equal(launcher.snapshot().status, "ready");
  }
});
test("launch failures stay visible and repeated taps during a launch are ignored", async () => {
  let release;
  const calls = [];
  const { launcher } = stub({
    launch: (input) => {
      calls.push(input.packageName);
      return new Promise((_, reject) => {
        release = () => reject(Error("App is unavailable"));
      });
    },
  });
  await launcher.load();
  const first = launcher.launch(apps[2]);
  await launcher.launch(apps[0]);
  assert.deepEqual(calls, ["com.android.chrome"]);
  release();
  await first;
  assert.equal(launcher.snapshot().launching, null);
  assert.equal(
    launcher.snapshot().launchError,
    "Chrome could not be opened. App is unavailable",
  );
  launcher.clearError();
  assert.equal(launcher.snapshot().launchError, null);
});
test("typing a search while apps are still loading does not strand the drawer in its loading state", async () => {
  let release;
  const { launcher } = stub({
    list: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const loading = launcher.load();
  assert.equal(launcher.snapshot().status, "loading");
  launcher.clearError();
  release({ apps });
  await loading;
  assert.equal(launcher.snapshot().status, "ready");
  assert.equal(launcher.snapshot().apps.length, 4);
});
test("a stale list read cannot overwrite a newer one", async () => {
  const pending = [];
  const { launcher } = stub({
    list: () => new Promise((resolve) => pending.push(resolve)),
  });
  const older = launcher.load(),
    newer = launcher.load();
  pending[1]({ apps: [apps[0]] });
  await newer;
  pending[0]({ apps });
  await older;
  assert.deepEqual(
    launcher.snapshot().apps.map((a) => a.label),
    ["Settings"],
  );
});

/** In-memory favorites store; `fail` makes the next writes throw like a full or blocked storage. */
function memoryFavorites(initial = []) {
  const store = {
    keys: [...initial],
    writes: 0,
    fail: false,
    read() {
      return [...store.keys];
    },
    write(keys) {
      if (store.fail) throw Error("QuotaExceededError");
      store.writes++;
      store.keys = [...keys];
    },
  };
  return store;
}
const twins = [
  {
    packageName: "org.example.notes",
    activityName: "org.example.notes.Main",
    label: "Notes",
  },
  {
    packageName: "com.vendor.notes",
    activityName: "com.vendor.notes.Launch",
    label: "Notes",
  },
  {
    packageName: "com.vendor.suite",
    activityName: "com.vendor.suite.MailActivity",
    label: "Suite",
  },
  {
    packageName: "com.vendor.suite",
    activityName: "com.vendor.suite.CalendarActivity",
    label: "Suite",
  },
  {
    packageName: "com.vendor.notes",
    activityName: "com.vendor.notes.Launch",
    label: "Notes",
    user: "10",
    profile: "work",
    locked: true,
  },
  {
    packageName: "com.android.settings",
    activityName: "com.android.settings.Settings",
    label: "Settings",
  },
];

test("an entry is identified by package, activity and profile, never by its label", async () => {
  assert.equal(appKey({ packageName: "a.b" }), "a.b");
  assert.equal(appKey(twins[0]), "org.example.notes/org.example.notes.Main");
  assert.equal(appKey(twins[4]), "com.vendor.notes/com.vendor.notes.Launch#10");
  const calls = [];
  const { launcher } = stub({
    list: async () => ({ apps: [...twins, twins[1]] }),
    launch: async (input) => {
      calls.push(input);
    },
  });
  await launcher.load();
  assert.equal(
    launcher.snapshot().apps.length,
    6,
    "same-label and same-package entries all stay; only an identical component is dropped",
  );
  await launcher.launch(twins[1]);
  await launcher.launch(twins[3]);
  await launcher.launch(twins[4]);
  assert.deepEqual(calls, [
    {
      packageName: "com.vendor.notes",
      activityName: "com.vendor.notes.Launch",
    },
    {
      packageName: "com.vendor.suite",
      activityName: "com.vendor.suite.CalendarActivity",
    },
    {
      packageName: "com.vendor.notes",
      activityName: "com.vendor.notes.Launch",
      user: "10",
    },
  ]);
});
test("entries with the same label are told apart by package, activity or profile", () => {
  const details = describeLauncherApps(twins);
  assert.deepEqual(details.get(appKey(twins[0])), ["org.example.notes"]);
  assert.deepEqual(details.get(appKey(twins[1])), ["com.vendor.notes"]);
  assert.deepEqual(details.get(appKey(twins[2])), ["MailActivity"]);
  assert.deepEqual(details.get(appKey(twins[3])), ["CalendarActivity"]);
  assert.deepEqual(details.get(appKey(twins[4])), ["Work · locked"]);
  assert.deepEqual(details.get(appKey(twins[5])), []);
  assert.deepEqual(
    describeLauncherApps([
      {
        packageName: "a.b",
        label: "Mail",
        user: "10",
        profile: "work",
        locked: false,
      },
    ]).get("a.b#10"),
    ["Work"],
  );
});
test("malformed component, profile or lock fields drop the entry", async () => {
  const bad = [
    { packageName: "a.b", label: "A", activityName: "" },
    { packageName: "a.c", label: "B", activityName: 7 },
    { packageName: "a.d", label: "C", user: "ten" },
    { packageName: "a.e", label: "D", user: 10 },
    { packageName: "a.f", label: "E", profile: "admin" },
    { packageName: "a.g", label: "F", locked: "yes" },
  ];
  const { launcher } = stub({
    list: async () => ({ apps: [...bad, twins[4]] }),
  });
  await launcher.load();
  assert.deepEqual(launcher.snapshot().apps.map(appKey), [
    "com.vendor.notes/com.vendor.notes.Launch#10",
  ]);
});
test("favorites keep their order, persist through the store and survive a new launcher", async () => {
  const favorites = memoryFavorites();
  const bridge = {
    list: async () => ({ apps: twins }),
    launch: async () => {},
  };
  const launcher = createLauncher(bridge, () => {}, { favorites });
  await launcher.load();
  launcher.toggleFavorite(twins[5]);
  launcher.toggleFavorite(twins[1]);
  launcher.toggleFavorite(twins[3]);
  assert.deepEqual(
    launcher.favoriteApps().map((a) => a.activityName),
    [
      "com.android.settings.Settings",
      "com.vendor.notes.Launch",
      "com.vendor.suite.CalendarActivity",
    ],
  );
  assert.equal(launcher.isFavorite(twins[1]), true);
  assert.equal(
    launcher.isFavorite(twins[0]),
    false,
    "the other Notes is a different app",
  );
  assert.equal(
    launcher.isFavorite(twins[4]),
    false,
    "the work copy is a different entry",
  );
  launcher.moveFavorite(twins[3], -1);
  launcher.moveFavorite(twins[5], -1); // already first: no change
  launcher.moveFavorite(twins[0], 1); // not a favorite: no change
  assert.deepEqual(favorites.keys, [
    appKey(twins[5]),
    appKey(twins[3]),
    appKey(twins[1]),
  ]);
  launcher.toggleFavorite(twins[5]);
  assert.deepEqual(favorites.keys, [appKey(twins[3]), appKey(twins[1])]);
  // A new launcher (process restart) reads the same order before any list arrives.
  const restarted = createLauncher(bridge, () => {}, { favorites });
  assert.deepEqual(restarted.snapshot().favorites, [
    appKey(twins[3]),
    appKey(twins[1]),
  ]);
  assert.deepEqual(
    restarted.favoriteApps(),
    [],
    "nothing is shown as a favorite until the device lists it",
  );
  await restarted.load();
  assert.deepEqual(
    restarted.favoriteApps().map((a) => a.activityName),
    ["com.vendor.suite.CalendarActivity", "com.vendor.notes.Launch"],
  );
});
test("a removed favorite disappears, keeps its place, and returns only when the device lists it again", async () => {
  const favorites = memoryFavorites([
    appKey(twins[5]),
    appKey(twins[0]),
    appKey(twins[2]),
  ]);
  let listed = twins;
  const launcher = createLauncher(
    { list: async () => ({ apps: listed }), launch: async () => {} },
    () => {},
    { favorites },
  );
  await launcher.load();
  listed = twins.filter((app) => app !== twins[0]);
  await launcher.refresh();
  assert.deepEqual(
    launcher.favoriteApps().map((a) => a.label),
    ["Settings", "Suite"],
  );
  launcher.moveFavorite(twins[2], -1);
  assert.deepEqual(
    favorites.keys,
    [appKey(twins[2]), appKey(twins[0]), appKey(twins[5])],
    "reordering swaps only installed favorites",
  );
  listed = twins;
  await launcher.refresh();
  assert.deepEqual(
    launcher.favoriteApps().map((a) => a.label),
    ["Suite", "Notes", "Settings"],
  );
});
test("a favorite that cannot be saved is not shown as saved", async () => {
  const favorites = memoryFavorites();
  const launcher = createLauncher(
    { list: async () => ({ apps: twins }), launch: async () => {} },
    () => {},
    { favorites },
  );
  await launcher.load();
  favorites.fail = true;
  launcher.toggleFavorite(twins[5]);
  assert.deepEqual(launcher.snapshot().favorites, []);
  assert.equal(
    launcher.snapshot().launchError,
    "Favorites could not be saved. Nothing changed.",
  );
  favorites.fail = false;
  launcher.toggleFavorite(twins[5]);
  assert.deepEqual(launcher.snapshot().favorites, [appKey(twins[5])]);
  assert.equal(launcher.snapshot().launchError, null);
  const none = createLauncher(
    { list: async () => ({ apps: twins }), launch: async () => {} },
    () => {},
  );
  await none.load();
  none.toggleFavorite(twins[5]);
  assert.deepEqual(none.snapshot().favorites, []);
  assert.equal(
    none.snapshot().launchError,
    "Favorites cannot be saved on this device.",
  );
});
test("the favorites limit is enforced and uninstalled favorites make room first", async () => {
  const many = Array.from({ length: MAX_FAVORITES + 1 }, (_, i) => ({
    packageName: `org.example.app${i}`,
    label: `App ${i}`,
  }));
  const favorites = memoryFavorites(["gone.one", "gone.two"]);
  const launcher = createLauncher(
    { list: async () => ({ apps: many }), launch: async () => {} },
    () => {},
    { favorites },
  );
  await launcher.load();
  for (const app of many.slice(0, MAX_FAVORITES)) launcher.toggleFavorite(app);
  assert.equal(favorites.keys.length, MAX_FAVORITES);
  assert.equal(favorites.keys.includes("gone.one"), false);
  launcher.toggleFavorite(many[MAX_FAVORITES]);
  assert.equal(favorites.keys.length, MAX_FAVORITES);
  assert.equal(
    launcher.snapshot().launchError,
    `You can keep ${MAX_FAVORITES} favorites. Remove one to add App ${MAX_FAVORITES}.`,
  );
});
test("localStorage favorites round-trip and unreadable or malformed data reads as none", () => {
  const data = new Map();
  const storage = {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => {
      data.set(key, String(value));
    },
  };
  const store = localFavorites(() => storage);
  assert.equal(store.read(), null);
  store.write(["a.b/a.b.Main", "c.d"]);
  assert.deepEqual(JSON.parse(data.get(FAVORITES_KEY)), {
    version: 2,
    keys: ["a.b/a.b.Main", "c.d"],
    defaultPolicy: "alpha-apps",
  });
  assert.deepEqual(store.read(), ["a.b/a.b.Main", "c.d"]);
  for (const raw of [
    "{",
    "[]",
    '{"version":3,"keys":["a"]}',
    '{"version":1,"keys":"a"}',
  ]) {
    data.set(FAVORITES_KEY, raw);
    assert.deepEqual(store.read(), []);
  }
  data.set(
    FAVORITES_KEY,
    JSON.stringify({ version: 1, keys: ["a", "a", 7, "", "b"] }),
  );
  assert.deepEqual(store.read(), ["a", "b"]);
  assert.deepEqual(
    localFavorites(() => {
      throw Error("SecurityError");
    }).read(),
    [],
  );
});
test("a refresh after an outside change replaces the list without a loading state and keeps the launch error", async () => {
  let listed = twins,
    release;
  const statuses = [];
  const launcher = createLauncher(
    {
      list: () =>
        release
          ? new Promise((resolve) => {
              const value = listed;
              release.push(() => resolve({ apps: value }));
            })
          : Promise.resolve({ apps: listed }),
      launch: async () => {
        throw Error("This app is no longer installed.");
      },
    },
    () => statuses.push(launcher?.snapshot().status),
  );
  await launcher.refresh();
  assert.equal(
    launcher.snapshot().status,
    "idle",
    "nothing is read before the drawer was ever opened",
  );
  await launcher.load();
  await launcher.launch(twins[0]);
  assert.equal(
    launcher.snapshot().launchError,
    "Notes could not be opened. This app is no longer installed.",
  );
  statuses.length = 0;
  release = [];
  listed = twins.slice(1);
  const refreshing = launcher.refresh();
  assert.equal(launcher.snapshot().status, "ready");
  assert.equal(launcher.snapshot().apps.length, 6);
  release[0]();
  await refreshing;
  assert.equal(launcher.snapshot().apps.length, 5);
  assert.equal(statuses.includes("loading"), false);
  assert.equal(
    launcher.snapshot().launchError,
    "Notes could not be opened. This app is no longer installed.",
  );
});
test("a failed launch re-reads the device so a removed app leaves the list, and it cannot be opened again", async () => {
  let listed = twins;
  const launches = [];
  const launcher = createLauncher(
    {
      list: async () => ({ apps: listed }),
      launch: async (input) => {
        launches.push(input.packageName);
        listed = twins.filter((app) => app.packageName !== input.packageName);
        const error = Error("This app is no longer installed.");
        error.code = "not-installed";
        throw error;
      },
    },
    () => {},
  );
  await launcher.load();
  await launcher.launch(twins[5]);
  assert.equal(
    launcher
      .snapshot()
      .apps.some((app) => app.packageName === "com.android.settings"),
    false,
  );
  assert.equal(launcher.snapshot().launching, null);
  await launcher.launch(twins[5]);
  assert.deepEqual(
    launches,
    ["com.android.settings"],
    "an entry missing from the current list is never sent to Android",
  );
  assert.equal(
    launcher.snapshot().launchError,
    "Settings is no longer installed.",
  );
});
test("a failed re-read after a failed launch clears the list instead of keeping a stale one", async () => {
  let reads = 0;
  const launcher = createLauncher(
    {
      list: async () => {
        if (reads++) throw Error("Package manager unavailable");
        return { apps: twins };
      },
      launch: async () => {
        throw Error("App could not be opened");
      },
    },
    () => {},
  );
  await launcher.load();
  await launcher.launch(twins[5]);
  assert.equal(launcher.snapshot().status, "failed");
  assert.deepEqual(launcher.snapshot().apps, []);
  await launcher.load();
  assert.equal(launcher.snapshot().status, "failed");
  await launcher.refresh();
  assert.deepEqual(
    launcher.snapshot().apps,
    [],
    "a failed refresh never restores an older inventory",
  );
});
test("a locked work-profile entry reports the profile state Android gave and launches nothing", async () => {
  const launcher = createLauncher(
    {
      list: async () => ({ apps: twins }),
      launch: async () => {
        const error = Error(
          "Work apps are paused or locked. Turn on work apps in Android, then try again.",
        );
        error.code = "profile-locked";
        throw error;
      },
    },
    () => {},
  );
  await launcher.load();
  await launcher.launch(twins[4]);
  assert.equal(
    launcher.snapshot().launchError,
    "Notes could not be opened. Work apps are paused or locked. Turn on work apps in Android, then try again.",
  );
  assert.equal(launcher.snapshot().launching, null);
});
test("a launch that fails while the drawer is still reading ends in a settled list, never a stuck loading state", async () => {
  let listed = twins,
    hold = null;
  const launcher = createLauncher(
    {
      list: () =>
        hold
          ? new Promise((resolve) => hold.push(() => resolve({ apps: listed })))
          : Promise.resolve({ apps: listed }),
      launch: async () => {
        listed = twins.slice(1);
        throw Error("This app is no longer installed.");
      },
    },
    () => {},
  );
  await launcher.load();
  // Reopening the drawer starts a full read; the previous rows are still on screen and one is tapped.
  hold = [];
  const reopening = launcher.load();
  assert.equal(launcher.snapshot().status, "loading");
  const launching = launcher.launch(twins[0]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    hold.length,
    2,
    "the failed launch started its own read of the device",
  );
  hold[1]();
  await launching;
  hold[0]();
  await reopening;
  assert.equal(launcher.snapshot().status, "ready");
  assert.equal(launcher.snapshot().apps.length, twins.length - 1);
  assert.equal(
    launcher.snapshot().launchError,
    "Notes could not be opened. This app is no longer installed.",
  );
});
test("same-label entries stay distinguishable when packages, activities and profiles overlap", () => {
  const mixed = [
    { packageName: "alpha:settings", label: "Settings" },
    { packageName: "com.android.settings", label: "Settings" },
    {
      packageName: "org.example.notes",
      activityName: "org.example.notes.Main",
      label: "Notes",
    },
    {
      packageName: "com.vendor.notes",
      activityName: "com.vendor.notes.One",
      label: "Notes",
    },
    {
      packageName: "com.vendor.notes",
      activityName: "com.vendor.notes.Two",
      label: "Notes",
    },
    {
      packageName: "com.vendor.suite",
      activityName: "com.vendor.suite.mail.Main",
      label: "Suite",
    },
    {
      packageName: "com.vendor.suite",
      activityName: "com.vendor.suite.calendar.Main",
      label: "Suite",
    },
    {
      packageName: "com.vendor.chat",
      activityName: "com.vendor.chat.Main",
      label: "Chat",
      user: "10",
      profile: "work",
      locked: false,
    },
    {
      packageName: "com.vendor.chat",
      activityName: "com.vendor.chat.Main",
      label: "Chat",
      user: "11",
      profile: "work",
      locked: false,
    },
  ];
  const details = describeLauncherApps(mixed);
  assert.deepEqual(
    mixed.map((app) => details.get(appKey(app))),
    [
      ["Alpha Phone"],
      ["com.android.settings"],
      ["org.example.notes"],
      ["com.vendor.notes", "One"],
      ["com.vendor.notes", "Two"],
      ["com.vendor.suite.mail.Main"],
      ["com.vendor.suite.calendar.Main"],
      ["Work", "com.vendor.chat.Main", "profile 10"],
      ["Work", "com.vendor.chat.Main", "profile 11"],
    ],
  );
  assert.equal(
    new Set(
      mixed.map((app) => `${app.label}|${details.get(appKey(app)).join("|")}`),
    ).size,
    mixed.length,
    "no two rows read the same",
  );
});
test("rows that would still read the same get their full identity as a last resort", () => {
  // A profile entry without an activity, and an activity whose short name reads like a profile.
  const odd = [
    { packageName: "alpha:first", label: "Calendar" },
    { packageName: "alpha:second", label: "Calendar" },
    {
      packageName: "com.vendor.chat",
      label: "Chat",
      user: "10",
      profile: "work",
      locked: false,
    },
    {
      packageName: "com.vendor.chat",
      label: "Chat",
      user: "11",
      profile: "work",
      locked: false,
    },
    {
      packageName: "org.example.notes",
      activityName: "org.example.notes.Work",
      label: "Notes",
    },
    {
      packageName: "org.example.notes",
      activityName: "org.example.notes.Home",
      label: "Notes",
    },
    {
      packageName: "com.vendor.notes",
      activityName: "com.vendor.notes.Main",
      label: "Notes",
      user: "10",
      profile: "work",
      locked: false,
    },
  ];
  const details = describeLauncherApps(odd);
  assert.deepEqual(
    odd.map((app) => details.get(appKey(app))),
    [
      ["Alpha Phone", "alpha:first"],
      ["Alpha Phone", "alpha:second"],
      ["Work", "com.vendor.chat", "profile 10"],
      ["Work", "com.vendor.chat", "profile 11"],
      ["Work", "org.example.notes", "org.example.notes.Work"],
      ["Home"],
      ["Work", "com.vendor.notes", "com.vendor.notes.Main", "profile 10"],
    ],
  );
  // Every mix of packages, activities, labels and profiles: no two different entries read alike.
  let seed = 42;
  const next = (n) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
  const packages = ["a.one", "a.two", "b.one"],
    activities = ["Main", "x.Main", "Other", "Work", ""],
    labels = ["Notes", "notes", "Nótes", "Mail"],
    users = ["", "10", "11", "12"],
    kinds = { 10: "work", 11: "work", 12: "clone" };
  for (let round = 0; round < 3000; round++) {
    const byKey = new Map();
    for (let i = 0, count = 2 + next(7); i < count; i++) {
      const packageName = packages[next(3)],
        activity = activities[next(5)],
        user = users[next(4)],
        app = { packageName, label: labels[next(4)] };
      if (activity) app.activityName = `${packageName}.${activity}`;
      if (user)
        Object.assign(app, { user, profile: kinds[user], locked: !!next(2) });
      byKey.set(appKey(app), app);
    }
    const list = [...byKey.values()],
      described = describeLauncherApps(list);
    const shown = list.map(
      (app) =>
        `${app.label.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()}|${described.get(appKey(app)).join("|")}`,
    );
    assert.equal(
      new Set(shown).size,
      list.length,
      JSON.stringify(
        list.map((app) => [appKey(app), app.label, described.get(appKey(app))]),
      ),
    );
  }
});
test("a Phone shortcut whose handler is gone reports why and leaves after the device is read again", async () => {
  let handler = true;
  const { launcher, calls } = stub({
    resolveDefault: async () =>
      handler
        ? {
            role: "dial",
            available: true,
            packageName: "com.android.dialer",
            label: "Phone",
          }
        : { role: "dial", available: false },
    openDefault: async () => {
      handler = false;
      throw Error("No app on this phone handles this");
    },
  });
  await launcher.load();
  assert.equal(launcher.snapshot().dial.packageName, "com.android.dialer");
  await launcher.openDial();
  assert.equal(
    launcher.snapshot().dial,
    null,
    "the stale shortcut is not offered again",
  );
  assert.equal(launcher.snapshot().launching, null);
  assert.equal(launcher.snapshot().status, "ready");
  assert.equal(
    launcher.snapshot().launchError,
    "Phone could not be opened. No app on this phone handles this",
  );
  assert.equal(
    calls.filter((call) => call[0] === "list").length,
    2,
    "one read on open, one after the refusal",
  );
  await launcher.openDial();
  assert.equal(
    launcher.snapshot().launchError,
    "Phone could not be opened. No app on this phone handles this",
    "nothing further is attempted without a handler",
  );
});

test("fresh Home defaults to product apps and explicit choices survive restart", async () => {
  let saved = null;
  const favorites = {
    read: () => saved,
    write: (keys) => {
      saved = [...keys];
    },
  };
  const builtin = { packageName: "alpha:notes", label: "Notes" };
  const bridge = { list: async () => ({ apps }), launch: async () => {} };
  const launcher = createLauncher(bridge, () => {}, { favorites });
  launcher.setBuiltins([builtin]);
  await launcher.load();
  assert.deepEqual(launcher.favoriteApps().map(appKey), [appKey(builtin)]);
  assert.deepEqual(
    launcher.snapshot().apps.map(appKey),
    [appKey(builtin), ...apps.map(appKey)],
    "All apps keeps the full inventory",
  );
  launcher.toggleFavorite(builtin);
  assert.equal(
    launcher.snapshot().apps.some((a) => appKey(a) === appKey(builtin)),
    true,
    "All apps retains the unfavorited product app",
  );
  assert.equal(
    launcher.favoriteApps().some((a) => appKey(a) === appKey(builtin)),
    false,
  );
  launcher.toggleFavorite(builtin);
  launcher.moveFavorite(builtin, -1);
  const expected = saved;
  const restarted = createLauncher(bridge, () => {}, { favorites });
  restarted.setBuiltins([builtin]);
  await restarted.load();
  assert.deepEqual(restarted.favoriteApps().map(appKey), expected);
});
test("explicit empty favorites stay empty across reload and capability-filtered product apps remain hidden", async () => {
  const favorites = memoryFavorites([]);
  const launcher = createLauncher(
    { list: async () => ({ apps }), launch: async () => {} },
    () => {},
    { favorites },
  );
  launcher.setBuiltins([{ packageName: "alpha:notes", label: "Notes" }]);
  await launcher.load();
  assert.deepEqual(launcher.favoriteApps(), []);
  launcher.toggleFavorite({ packageName: "alpha:notes", label: "Notes" });
  launcher.setBuiltins([]);
  assert.deepEqual(launcher.favoriteApps(), []);
  assert.deepEqual(
    favorites.keys,
    ["alpha:notes"],
    "Capability changes do not erase saved choices",
  );
});

test("legacy installed favorites migrate to v2 without hiding product Home apps, and browser mirrors deduplicate", async () => {
  const aliases = {
    "browser.mail": "alpha:inbox",
    "browser.notes": "alpha:notes",
    "browser.browser": "alpha:browser",
  };
  const builtins = [
    { packageName: "alpha:inbox", label: "Inbox" },
    { packageName: "alpha:notes", label: "Notes" },
    { packageName: "alpha:browser", label: "Browser" },
  ];
  for (const keys of [["browser.browser", "browser.mail"], []]) {
    const data = new Map([
      [FAVORITES_KEY, JSON.stringify({ version: 1, keys })],
    ]);
    const store = localFavorites(() => ({
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => data.set(key, value),
    }));
    const nativeNotes = {
      packageName: "org.other.notes",
      activityName: "Notes",
      user: "10",
      label: "Notes",
    };
    const listed = [
      ...Object.keys(aliases).map((packageName) => ({
        packageName,
        label: "Mirror",
      })),
      nativeNotes,
    ];
    const launcher = createLauncher(
      { list: async () => ({ apps: listed }), launch: async () => {} },
      () => {},
      { favorites: store, aliases },
    );
    launcher.setBuiltins(builtins);
    await launcher.load();
    assert.deepEqual(launcher.snapshot().apps.map(appKey), [
      ...builtins.map(appKey),
      appKey(nativeNotes),
    ]);
    assert.deepEqual(
      launcher.favoriteApps().map(appKey),
      keys.length
        ? ["alpha:browser", "alpha:inbox", "alpha:notes"]
        : builtins.map(appKey),
    );
    assert.equal(JSON.parse(data.get(FAVORITES_KEY)).version, 2);
    assert.equal(
      launcher.isFavorite(nativeNotes),
      false,
      "Legacy nonfavorite Android app remains nonfavorite",
    );
    const restarted = createLauncher(
      { list: async () => ({ apps: listed }), launch: async () => {} },
      () => {},
      { favorites: store, aliases },
    );
    restarted.setBuiltins(builtins);
    await restarted.load();
    assert.deepEqual(
      restarted.snapshot().favorites,
      launcher.snapshot().favorites,
    );
  }
});
test("v2 intentional empty Home stays empty, while native packages with matching names are not aliased", async () => {
  const data = new Map([
    [FAVORITES_KEY, JSON.stringify({ version: 2, keys: [] })],
  ]);
  const store = localFavorites(() => ({
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  }));
  const native = {
    packageName: "browser.notes",
    activityName: "NativeNotes",
    user: "10",
    label: "Notes",
  };
  const launcher = createLauncher(
    { list: async () => ({ apps: [native] }), launch: async () => {} },
    () => {},
    { favorites: store, aliases: { "browser.notes": "alpha:notes" } },
  );
  launcher.setBuiltins([{ packageName: "alpha:notes", label: "Notes" }]);
  await launcher.load();
  assert.deepEqual(launcher.favoriteApps(), []);
  assert.equal(
    launcher.snapshot().apps.some((app) => appKey(app) === appKey(native)),
    true,
  );
});

test("pristine legacy all-app defaults migrate once; custom shortcuts and the original choices remain", async () => {
  const builtin = { packageName: "alpha:notes", label: "Notes" };
  const all = [appKey(builtin), ...apps.map(appKey)];
  for (const keys of [all, [appKey(apps[2]), appKey(builtin)], []]) {
    const data = new Map([
      [FAVORITES_KEY, JSON.stringify({ version: 2, keys })],
    ]);
    const store = localFavorites(() => ({
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => data.set(key, value),
    }));
    const launcher = createLauncher(
      {
        list: async () => ({ apps }),
        launch: async () => assert.fail("Migration must not launch an app"),
      },
      () => {},
      { favorites: store },
    );
    launcher.setBuiltins([builtin]);
    await launcher.load();
    assert.deepEqual(
      launcher.favoriteApps().map(appKey),
      keys === all ? [appKey(builtin)] : keys,
    );
    assert.deepEqual(
      launcher.snapshot().apps.map(appKey),
      all,
      "The installed-app inventory is unchanged",
    );
    const record = JSON.parse(data.get(FAVORITES_KEY));
    assert.deepEqual(record.previousDefaults, keys);
    assert.equal(record.defaultPolicy, "alpha-apps");
    // An explicit modern choice of every app must never be mistaken for the old default.
    store.write(all);
    const restarted = createLauncher(
      { list: async () => ({ apps }), launch: async () => {} },
      () => {},
      { favorites: store },
    );
    restarted.setBuiltins([builtin]);
    await restarted.load();
    assert.deepEqual(restarted.favoriteApps().map(appKey), all);
  }
});

test("a newer explicit preference wins while legacy default migration waits for Android", async () => {
  const builtin = { packageName: "alpha:notes", label: "Notes" };
  const data = new Map([
    [
      FAVORITES_KEY,
      JSON.stringify({
        version: 2,
        keys: [appKey(builtin), ...apps.map(appKey)],
      }),
    ],
  ]);
  const store = localFavorites(() => ({
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  }));
  let finish;
  const launcher = createLauncher(
    {
      list: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      launch: async () => {},
    },
    () => {},
    { favorites: store },
  );
  launcher.setBuiltins([builtin]);
  const pending = launcher.load();
  const chosen = JSON.stringify({
    version: 2,
    keys: [appKey(apps[2])],
    defaultPolicy: "alpha-apps",
  });
  data.set(FAVORITES_KEY, chosen);
  finish({ apps });
  await pending;
  assert.deepEqual(launcher.favoriteApps().map(appKey), [appKey(apps[2])]);
  assert.equal(
    data.get(FAVORITES_KEY),
    chosen,
    "The automatic migration must not overwrite a newer choice",
  );
});

test("each branded host keeps its own favorites key and migration policy", () => {
  const data = new Map();
  const storage = () => ({
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  });
  const alpha = localFavorites(storage),
    eliza = sharedLocalFavorites(storage);
  alpha.write(["alpha:notes"]);
  eliza.write(["eliza:notes"]);
  assert.deepEqual(alpha.read(), ["alpha:notes"]);
  assert.deepEqual(eliza.read(), ["eliza:notes"]);
  assert.equal(JSON.parse(data.get(FAVORITES_KEY)).defaultPolicy, "alpha-apps");
  assert.equal(
    JSON.parse(data.get("eliza.launcher.favorites.v1")).defaultPolicy,
    "eliza-apps",
  );
});

test("an unavailable Android inventory retains builtin Home entries", async () => {
  const builtin = { packageName: "alpha:notes", label: "Notes" };
  const launcher = createLauncher(
    {
      list: async () => {
        throw Error("Unavailable");
      },
      launch: async () => {},
    },
    () => {},
    { favorites: { read: () => null, write() {} } },
  );
  launcher.setBuiltins([builtin]);
  await launcher.load();
  assert.equal(launcher.snapshot().status, "failed");
  assert.deepEqual(launcher.favoriteApps(), [builtin]);
});

test("retiring a pending inventory preserves newer favorites and allows a fresh load", async () => {
  let complete;
  let saved = null;
  let writes = 0;
  let changes = 0;
  const launcher = createLauncher(
    {
      list: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
      launch: async () => {},
    },
    () => changes++,
    {
      favorites: {
        read: () => saved,
        write: (keys) => {
          saved = [...keys];
          writes++;
        },
      },
    },
  );
  launcher.setBuiltins([{ packageName: "eliza:notes", label: "Notes" }]);
  const retired = launcher.load();
  launcher.cancelPending();
  saved = ["chosen.app"];
  const atRetirement = changes;
  complete({ apps: [{ packageName: "stale.app", label: "Stale" }] });
  await retired;
  assert.equal(changes, atRetirement);
  assert.equal(writes, 0);
  assert.deepEqual(saved, ["chosen.app"]);
  const reopened = launcher.load();
  complete({ apps: [{ packageName: "chosen.app", label: "Chosen" }] });
  await reopened;
  assert.equal(launcher.snapshot().status, "ready");
  assert.deepEqual(launcher.favoriteApps().map(appKey), ["chosen.app"]);
  assert.equal(writes, 0);
});

test("retired launch and dialer failures do not refresh an inactive host", async () => {
  for (const kind of ["launch", "dial"]) {
    let reject;
    let reads = 0;
    let changes = 0;
    const failure = () =>
      new Promise((_, fail) => {
        reject = fail;
      });
    const launcher = createLauncher(
      {
        list: async () => {
          reads++;
          return { apps };
        },
        launch: failure,
        resolveDefault: async () => ({ role: "dial", available: true }),
        openDefault: failure,
      },
      () => changes++,
    );
    await launcher.load();
    const pending =
      kind === "launch" ? launcher.launch(apps[0]) : launcher.openDial();
    launcher.cancelPending();
    const retiredChanges = changes;
    reject(Error("Late refusal"));
    await pending;
    assert.equal(reads, 1);
    assert.equal(changes, retiredChanges);
    assert.equal(launcher.snapshot().launching, null);
    assert.equal(launcher.snapshot().launchError, null);
    await launcher.load();
    assert.equal(reads, 2, "the controller remains usable");
  }
});
