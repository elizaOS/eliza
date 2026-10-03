import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

/** Refuse mounted or stacked fixture disks before even the test's GPT reset. */
export function assertUnmountedFixtureTree(tree, diskPath) {
  assert.ok(/^\/dev\/[A-Za-z0-9_-]+$/.test(diskPath));
  assert.equal(
    tree?.blockdevices?.length,
    1,
    "expected exactly one fixture disk",
  );
  const root = tree.blockdevices[0];
  assert.equal(root.path, diskPath);
  assert.equal(root.type, "disk");
  const paths = new Set();
  const visit = (node, isRoot) => {
    assert.ok(Array.isArray(node.mountpoints), "mount state must be explicit");
    assert.ok(!paths.has(node.path), "duplicate fixture device");
    paths.add(node.path);
    assert.ok(
      node.mountpoints.every((value) => value === null),
      `fixture device is mounted: ${node.path}`,
    );
    if (!isRoot) {
      assert.equal(
        node.type,
        "part",
        "stacked fixture devices are not supported",
      );
      assert.ok(
        typeof node.path === "string" &&
          node.path.startsWith(diskPath) &&
          /^p?[1-9][0-9]*$/.test(node.path.slice(diskPath.length)),
        "unexpected fixture descendant",
      );
    }
    assert.ok(node.children === undefined || Array.isArray(node.children));
    assert.ok(
      isRoot || !node.children?.length,
      "fixture partitions must not have descendants",
    );
    for (const child of node.children ?? []) visit(child, false);
  };
  visit(root, true);
}

export function assertUnmountedFixtureDisk(diskPath) {
  const tree = JSON.parse(
    execFileSync(
      "lsblk",
      [
        "--json",
        "--tree",
        "--paths",
        "--output",
        "PATH,TYPE,MOUNTPOINTS",
        diskPath,
      ],
      { encoding: "utf8" },
    ),
  );
  assertUnmountedFixtureTree(tree, diskPath);
}
