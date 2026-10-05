import assert from "node:assert/strict";
import test from "node:test";
import { assertUnmountedFixtureTree } from "../../linux/installer/native/qualification-inventory.mjs";

const fixture = () => ({
  blockdevices: [
    {
      path: "/dev/vdc",
      type: "disk",
      mountpoints: [null],
      children: [{ path: "/dev/vdc1", type: "part", mountpoints: [null] }],
    },
  ],
});
test("fixture disk inventory requires one unmounted disk with only its partitions", () => {
  assert.doesNotThrow(() => assertUnmountedFixtureTree(fixture(), "/dev/vdc"));
  for (const mutate of [
    (tree) => {
      tree.blockdevices[0].mountpoints = ["/boot"];
    },
    (tree) => {
      tree.blockdevices[0].children[0].mountpoints = ["/mnt"];
    },
    (tree) => {
      delete tree.blockdevices[0].children[0].mountpoints;
    },
    (tree) => {
      tree.blockdevices[0].children.push(
        structuredClone(tree.blockdevices[0].children[0]),
      );
    },
    (tree) => {
      tree.blockdevices[0].children[0].children = [
        { path: "/dev/vdc2", type: "part", mountpoints: [null] },
      ];
    },
    (tree) => {
      tree.blockdevices[0].children[0].type = "crypt";
    },
    (tree) => {
      tree.blockdevices[0].children[0].path = "/dev/vda1";
    },
    (tree) => {
      tree.blockdevices.push(structuredClone(tree.blockdevices[0]));
    },
    (tree) => {
      tree.blockdevices[0].path = "/dev/vda";
    },
  ]) {
    const tree = fixture();
    mutate(tree);
    assert.throws(() => assertUnmountedFixtureTree(tree, "/dev/vdc"));
  }
});

test("lsblk empty arrays explicitly describe unmounted fixture devices", () => {
  const tree = fixture();
  tree.blockdevices[0].mountpoints = [];
  tree.blockdevices[0].children[0].mountpoints = [];
  assert.doesNotThrow(() => assertUnmountedFixtureTree(tree, "/dev/vdc"));
  tree.blockdevices[0].children[0].mountpoints = [""];
  assert.throws(() => assertUnmountedFixtureTree(tree, "/dev/vdc"));
});
