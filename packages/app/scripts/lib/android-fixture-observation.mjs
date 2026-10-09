import assert from "node:assert/strict";

const identifier = /^[A-Za-z0-9_.:-]+$/;
const packageIdentifier = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const namedEntities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Read one identifier-named string from Android's SharedPreferences XML.
 * Deliberately not a general XML parser: no attributes/entities are evaluated.
 */
export function androidPreferenceString(xml, key) {
  assert.equal(typeof xml, "string");
  assert.match(
    xml,
    /^\s*(?:<\?xml[^?]*\?>\s*)?<map>[\s\S]*<\/map>\s*$/,
    "Complete Android preference map required",
  );
  assert.ok(!/<!/.test(xml), "Unsupported XML declaration or comment");
  assert.match(key, identifier);
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [
    ...xml.matchAll(
      new RegExp(
        `<string\\s+name="${escaped}"\\s*>([\\s\\S]*?)<\\/string>`,
        "g",
      ),
    ),
  ];
  assert.ok(matches.length <= 1, "Ambiguous preference string");
  if (!matches.length) return null;
  const text = matches[0][1];
  assert.ok(!text.includes("<"), "Unexpected markup in preference string");
  return text.replace(/&([^;\s]*);|&/g, (_entity, name) => {
    if (Object.hasOwn(namedEntities, name)) return namedEntities[name];
    assert.match(
      name ?? "",
      /^#(?:[0-9]+|x[0-9a-fA-F]+)$/,
      "Unsupported XML entity",
    );
    const point = name.startsWith("#x")
      ? Number.parseInt(name.slice(2), 16)
      : Number(name.slice(1));
    assert.ok(
      [9, 10, 13].includes(point) ||
        (point >= 0x20 && point <= 0xd7ff) ||
        (point >= 0xe000 && point <= 0xfffd) ||
        (point >= 0x10000 && point <= 0x10ffff),
      "Invalid XML character reference",
    );
    return String.fromCodePoint(point);
  });
}

/** Read-only observations for a fresh user owned by the caller's Android harness.
 * run is the harness's bounded, cancellable ADB executor. No app launch or
 * instrumentation is performed, so observing an alarm cannot stop its package.
 */
export function androidFixtureObserver({ run, packageName, androidUser }) {
  assert.equal(typeof run, "function");
  assert.match(packageName, packageIdentifier);
  assert.ok(
    Number.isSafeInteger(androidUser) && androidUser > 0,
    "Explicit fixture user required",
  );
  const user = String(androidUser);
  return {
    async preferenceString(file, key) {
      assert.match(file, identifier);
      assert.ok(file !== "." && file !== "..", "Preference filename required");
      assert.match(key, identifier);
      const xml = await run(
        "shell",
        "run-as",
        packageName,
        "--user",
        user,
        "cat",
        `shared_prefs/${file}.xml`,
      );
      return androidPreferenceString(xml, key);
    },
    async stopped() {
      const dump = await run("shell", "dumpsys", "package", packageName);
      // dumpsys repeats User N headings under Queries. Only package state in
      // the exact Packages block is authoritative, not a global user-row scan.
      const lines = String(dump).split(/\r?\n/);
      const sections = lines.flatMap((line, index) =>
        line === "Packages:" ? [index] : [],
      );
      assert.equal(
        sections.length,
        1,
        "Exactly one package inventory required",
      );
      const start = sections[0] + 1;
      const boundary = lines.findIndex(
        (line, index) => index >= start && /^\S/.test(line),
      );
      const inventory = lines.slice(start, boundary < 0 ? undefined : boundary);
      const packages = inventory.flatMap((line, index) => {
        const match = line.match(/^ {2}Package \[([^\]]+)\] \([^)]*\):$/);
        return match ? [{ name: match[1], index }] : [];
      });
      const targets = packages.filter((item) => item.name === packageName);
      assert.equal(targets.length, 1, "Exactly one fixture package required");
      const packageStart = targets[0].index;
      const packageEnd = packages.find(
        (item) => item.index > packageStart,
      )?.index;
      const rows = inventory
        .slice(packageStart + 1, packageEnd)
        .filter((line) => new RegExp(`^    User ${user}:`).test(line));
      assert.equal(
        rows.length,
        1,
        "Exactly one fixture-user package state required",
      );
      const states = [...rows[0].matchAll(/\bstopped=(true|false)\b/g)];
      assert.equal(
        states.length,
        1,
        "Unambiguous package stopped state required",
      );
      return states[0][1] === "true";
    },
    async notification({ id, tag }) {
      assert.ok(
        Number.isInteger(id) && id >= -2147483648 && id <= 2147483647,
        "Notification ID required",
      );
      assert.equal(typeof tag, "string");
      assert.ok(
        tag.length > 0 && !/[|\r\n]/.test(tag),
        "Unambiguous notification tag required",
      );
      const keys = await run("shell", "cmd", "notification", "list");
      return String(keys)
        .split(/\r?\n/)
        .some((line) => {
          const fields = line.trim().split("|");
          return (
            fields.length >= 5 &&
            /^\d+$/.test(fields[4]) &&
            fields[0] === user &&
            fields[1] === packageName &&
            fields[2] === String(id) &&
            fields[3] === tag
          );
        });
    },
  };
}
