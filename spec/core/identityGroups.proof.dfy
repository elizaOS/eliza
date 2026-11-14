lemma IdentityFilters(s: IdentityGroups)
  ensures alwaysIdentitiesAreUnique(s) == !((exists node :: node in s.nodes && !((|ProofLib.Filter((other: IdentityNode) => (other.identity == node.identity), s.nodes)| == 1))))
{}

lemma RepresentativeFilter(nodes: seq<IdentityNode>, identity: string)
  ensures representative(nodes, identity) == (if ((0 <= 0) && (0 < |ProofLib.Filter((node: IdentityNode) => (node.identity == identity), nodes)|)) then ProofLib.Filter((node: IdentityNode) => (node.identity == identity), nodes)[0] else IdentityNode(identity, identity)).root
{}

lemma WithIdentityPreserves(s: IdentityGroups, identity: string)
  requires inv(s)
  ensures inv(IdentityGroups(withIdentity(s.nodes, identity)))
  ensures forall node :: node in s.nodes ==> registered(withIdentity(s.nodes, identity), node.identity)
  ensures forall node :: node in s.nodes ==> node in withIdentity(s.nodes, identity)
{
  var nodes := withIdentity(s.nodes, identity);
  IdentityFilters(s);
  IdentityFilters(IdentityGroups(nodes));
  if !registered(s.nodes, identity) {
    forall node | node in nodes
      ensures |ProofLib.Filter((other: IdentityNode) => (other.identity == node.identity), nodes)| == 1
    {
      ProofLib.FilterAppend((other: IdentityNode) => (other.identity == node.identity), s.nodes, IdentityNode(identity, identity));
      if node.identity == identity {
        ProofLib.FilterNone((other: IdentityNode) => (other.identity == identity), s.nodes);
      } else {
        assert node in s.nodes;
        assert |ProofLib.Filter((other: IdentityNode) => (other.identity == node.identity), s.nodes)| == 1;
      }
    }
    forall node | node in nodes
      ensures exists root :: root in nodes && root.identity == node.root && root.root == root.identity
    {
      if node == IdentityNode(identity, identity) {
        assert IdentityNode(identity, identity) in nodes;
      } else {
        assert node in s.nodes;
        var root :| root in s.nodes && root.identity == node.root && root.root == root.identity;
        assert root in nodes;
      }
    }
  }
  forall node | node in s.nodes
    ensures registered(nodes, node.identity)
  {
    assert node in nodes;
  }
}

lemma RegisteredRoot(nodes: seq<IdentityNode>, identity: string)
  requires inv(IdentityGroups(nodes))
  requires registered(nodes, identity)
  ensures exists root :: root in nodes && root.identity == representative(nodes, identity) && root.root == root.identity
{
  RepresentativeFilter(nodes, identity);
  var candidate :| candidate in nodes && candidate.identity == identity;
  ProofLib.FilterMember((node: IdentityNode) => (node.identity == identity), nodes, candidate);
  var matches := ProofLib.Filter((node: IdentityNode) => (node.identity == identity), nodes);
  assert |matches| > 0;
  ProofLib.FilterMember((node: IdentityNode) => (node.identity == identity), nodes, matches[0]);
  assert matches[0] in nodes;
  assert representative(nodes, identity) == matches[0].root;
  var root :| root in nodes && root.identity == matches[0].root && root.root == root.identity;
}

lemma findIdentity_ensures(s: IdentityGroups, identity: string)
  ensures (inv(s) ==> alwaysIdentitiesAreUnique(findIdentity(s, identity)))
  ensures (inv(s) ==> alwaysRootsAreRegisteredAndCanonical(findIdentity(s, identity)))
  ensures (inv(s) ==> stepOnlyClearRemovesIdentities(s, "findIdentity", findIdentity(s, identity)))
{
  if inv(s) { WithIdentityPreserves(s, identity); }
}

lemma registerIdentity_ensures(s: IdentityGroups, identity: string)
  ensures (inv(s) ==> alwaysIdentitiesAreUnique(registerIdentity(s, identity)))
  ensures (inv(s) ==> alwaysRootsAreRegisteredAndCanonical(registerIdentity(s, identity)))
  ensures (inv(s) ==> stepOnlyClearRemovesIdentities(s, "registerIdentity", registerIdentity(s, identity)))
{
  if inv(s) { WithIdentityPreserves(s, identity); }
}

lemma IdentityMapPreserves(nodes: seq<IdentityNode>, updated: seq<IdentityNode>)
  requires alwaysIdentitiesAreUnique(IdentityGroups(nodes))
  requires |nodes| == |updated|
  requires forall i :: 0 <= i < |nodes| ==> nodes[i].identity == updated[i].identity
  ensures alwaysIdentitiesAreUnique(IdentityGroups(updated))
  ensures forall node :: node in nodes ==> registered(updated, node.identity)
{
  IdentityFilters(IdentityGroups(nodes));
  IdentityFilters(IdentityGroups(updated));
  forall node | node in updated
    ensures |ProofLib.Filter((other: IdentityNode) => (other.identity == node.identity), updated)| == 1
  {
    var i :| 0 <= i < |updated| && updated[i] == node;
    assert nodes[i].identity == node.identity;
    ProofLib.FilterLengthPointwise((other: IdentityNode) => (other.identity == node.identity), (other: IdentityNode) => (other.identity == node.identity), nodes, updated);
    assert |ProofLib.Filter((other: IdentityNode) => (other.identity == node.identity), nodes)| == 1;
  }
  forall node | node in nodes
    ensures registered(updated, node.identity)
  {
    var i :| 0 <= i < |nodes| && nodes[i] == node;
    assert updated[i].identity == node.identity;
    assert updated[i] in updated;
  }
}

lemma RootMapPreserves(nodes: seq<IdentityNode>, updated: seq<IdentityNode>, leftRoot: string, rightRoot: string)
  requires alwaysRootsAreRegisteredAndCanonical(IdentityGroups(nodes))
  requires |nodes| == |updated|
  requires exists root :: root in nodes && root.identity == leftRoot && root.root == leftRoot
  requires forall i :: 0 <= i < |nodes| ==> updated[i] == (if nodes[i].root == rightRoot then nodes[i].(root := leftRoot) else nodes[i])
  ensures alwaysRootsAreRegisteredAndCanonical(IdentityGroups(updated))
{
  forall node | node in updated
    ensures exists root :: root in updated && root.identity == node.root && root.root == root.identity
  {
    var i :| 0 <= i < |updated| && updated[i] == node;
    if nodes[i].root == rightRoot {
      var root :| root in nodes && root.identity == leftRoot && root.root == leftRoot;
      var j :| 0 <= j < |nodes| && nodes[j] == root;
      assert updated[j].identity == leftRoot && updated[j].root == leftRoot;
      assert updated[j] in updated;
    } else {
      var root :| root in nodes && root.identity == nodes[i].root && root.root == root.identity;
      var j :| 0 <= j < |nodes| && nodes[j] == root;
      assert updated[j].identity == node.root && updated[j].root == node.root;
      assert updated[j] in updated;
    }
  }
}

lemma unionIdentities_ensures(s: IdentityGroups, left: string, right: string)
  ensures (inv(s) ==> alwaysIdentitiesAreUnique(unionIdentities(s, left, right)))
  ensures (inv(s) ==> alwaysRootsAreRegisteredAndCanonical(unionIdentities(s, left, right)))
  ensures (inv(s) ==> stepOnlyClearRemovesIdentities(s, "unionIdentities", unionIdentities(s, left, right)))
{
  if inv(s) {
    WithIdentityPreserves(s, left);
    var first := IdentityGroups(withIdentity(s.nodes, left));
    WithIdentityPreserves(first, right);
    var nodes := withIdentity(first.nodes, right);
    assert inv(IdentityGroups(nodes));
    assert registered(nodes, left) && registered(nodes, right);
    RegisteredRoot(nodes, left);
    var leftRoot := representative(nodes, left);
    var rightRoot := representative(nodes, right);
    var updated := unionIdentities(s, left, right).nodes;
    assert |updated| == |nodes|;
    assert forall i :: 0 <= i < |nodes| ==> updated[i] == (if nodes[i].root == rightRoot then nodes[i].(root := leftRoot) else nodes[i]);
    IdentityMapPreserves(nodes, updated);
    RootMapPreserves(nodes, updated, leftRoot, rightRoot);
    forall node | node in s.nodes
      ensures registered(updated, node.identity)
    {
      assert node in first.nodes;
      assert node in nodes;
    }
  }
}
