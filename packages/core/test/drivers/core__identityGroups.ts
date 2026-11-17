// spec/core/identityGroups.md, "Story: Merge identity groups without losing their members"; spec/core/identityGroups.md, "Every registered identity belongs to one registered canonical root"
import type { Driver, Options } from "../../gen/core__identityGroups.conformance.ts";
import type { IdentityGroups, IdentityNode } from "../../gen/core__identityGroups.ts";
import { UnionFind } from "../../src/utils/union-find.vibe";

const sets = new Map<string, UnionFind<string>>();

const setOf = (key: string): UnionFind<string> => {
  const existing = sets.get(key);
  if (existing) return existing;
  const created = new UnionFind<string>();
  sets.set(key, created);
  return created;
};

const byIdentity = (left: IdentityNode, right: IdentityNode): number =>
  left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0;

export const driver: Driver = {
  reset: () => {
    sets.clear();
  },
  dispatch: (key, event) => {
    const set = setOf(key);
    if (event.type === "registerIdentity") set.add(event.identity);
    else if (event.type === "unionIdentities") set.union(event.left, event.right);
    else set.clear();
    return "accepted";
  },
  observe: (key) => ({
    nodes: [...setOf(key).groups()]
      .flatMap(([root, members]) => members.map((identity) => ({ identity, root })))
      .sort(byIdentity),
  }),
};

export const options: Options = {
  view: (state: IdentityGroups) => ({ nodes: [...state.nodes].sort(byIdentity) }),
};
