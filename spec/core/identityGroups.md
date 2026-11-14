# Identity equivalence groups

The source is `packages/core/src/utils/union-find.ts` at
`72fed7e4069ecd35d61d886ab6eec5c02c137517`. The model stores the observed
root of each registered identity. Path compression changes internal
pointers while preserving this representation. An identity denotes a
Map key's equality identity, including reference identity for object keys.

## Story: Merge identity groups without losing their members

As a relationship service, I register identities idempotently, merge the
right group into the left root, and query membership without creating an
unknown identity. `find` and `union` register unknown identities lazily.
`componentOf` returns a singleton for an unknown identity without storing it.

### Every registered identity belongs to one registered canonical root

```quint
type IdentityNode = { identity: str, root: str }
type IdentityGroups = { nodes: List[IdentityNode] }
pure val initial: IdentityGroups = { nodes: List() }
pure def registered(nodes: List[IdentityNode], identity: str): bool = nodes.some(node => node.identity == identity)
pure def representative(nodes: List[IdentityNode], identity: str): str = nodes.select(node => node.identity == identity).nthOr(0, { identity: identity, root: identity }).root
pure def withIdentity(nodes: List[IdentityNode], identity: str): List[IdentityNode] = if (registered(nodes, identity)) nodes else nodes.append({ identity: identity, root: identity })
pure def registerIdentity(s: IdentityGroups, identity: str): IdentityGroups = { nodes: withIdentity(s.nodes, identity) }
pure def findIdentity(s: IdentityGroups, identity: str): IdentityGroups = { nodes: withIdentity(s.nodes, identity) }
pure def unionIdentities(s: IdentityGroups, left: str, right: str): IdentityGroups = {
  val nodes = withIdentity(withIdentity(s.nodes, left), right)
  val leftRoot = representative(nodes, left)
  val rightRoot = representative(nodes, right)
  { nodes: nodes.listMap(node => if (node.root == rightRoot) { ...node, root: leftRoot } else node) }
}
pure def connected(nodes: List[IdentityNode], left: str, right: str): bool = registered(nodes, left) and registered(nodes, right) and representative(nodes, left) == representative(nodes, right)
pure def componentMembers(nodes: List[IdentityNode], identity: str): List[str] = if (registered(nodes, identity)) nodes.select(node => node.root == representative(nodes, identity)).listMap(node => node.identity) else List(identity)
pure def clearGroups(s: IdentityGroups): IdentityGroups = initial
pure val identityValues = Set("a", "b", "c")
pure val leftValues = identityValues
pure val rightValues = identityValues
pure val nodesValues = Set(List(), List({ identity: "a", root: "a" }), List({ identity: "a", root: "a" }, { identity: "b", root: "a" }))
pure def alwaysIdentitiesAreUnique(s: IdentityGroups): bool = s.nodes.every(node => s.nodes.select(other => other.identity == node.identity).length() == 1)
pure def alwaysRootsAreRegisteredAndCanonical(s: IdentityGroups): bool = s.nodes.every(node => s.nodes.some(root => root.identity == node.root and root.root == root.identity))
pure def stepOnlyClearRemovesIdentities(before: IdentityGroups, via: str, after: IdentityGroups): bool = via != "clearGroups" implies before.nodes.every(node => registered(after.nodes, node.identity))
pure def lawConnectivityIsSymmetric(nodes: List[IdentityNode], left: str, right: str): bool = connected(nodes, left, right) == connected(nodes, right, left)
pure def lawUnknownMemberQueryIsSingleton(nodes: List[IdentityNode], identity: str): bool = not(registered(nodes, identity)) implies componentMembers(nodes, identity) == List(identity)
pure def sometimesMergedGroup(s: IdentityGroups): bool = s.nodes.length() >= 2 and s.nodes.some(node => node.identity != node.root)
```
