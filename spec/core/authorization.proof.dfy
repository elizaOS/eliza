lemma AuthorizationRoomFilter(requesterRooms: seq<string>, agentRooms: seq<string>)
  ensures authorizedRooms(requesterRooms, agentRooms) == ProofLib.Filter((set_x: string) => (set_x in agentRooms), requesterRooms)
{}

lemma lawRoomsRequireBothMemberships_ensures(requesterRooms: seq<string>, agentRooms: seq<string>)
  ensures (lawRoomsRequireBothMemberships(requesterRooms, agentRooms) == true)
{
  AuthorizationRoomFilter(requesterRooms, agentRooms);
  forall room | room in authorizedRooms(requesterRooms, agentRooms)
    ensures room in requesterRooms && room in agentRooms
  {
    ProofLib.FilterMember((set_x: string) => (set_x in agentRooms), requesterRooms, room);
  }
}

lemma GateDedupMembership(acc: seq<string>, names: seq<string>, target: string)
  ensures (target in Std.Collections.Seq.FoldLeft((set_acc: seq<string>, set_x: string) => (if (set_x in set_acc) then set_acc else (set_acc + [set_x])), acc, names)) == (target in acc || target in names)
  decreases |names|
{
  if |names| > 0 {
    var after := if names[0] in acc then acc else acc + [names[0]];
    GateDedupMembership(after, names[1..], target);
  }
}

lemma GateBlankMembership(names: seq<string>)
  ensures ("" in gateRoleNames(names)) == ("" in names)
{
  GateRoleNameMembership(names, "");
}

lemma GateRoleNameMembership(names: seq<string>, target: string)
  ensures (target in gateRoleNames(names)) == (exists original :: original in names && gateRoleKey(original) == target)
{
  var mapped := seq(|names|, i_map requires 0 <= i_map < |names| => var name := names[i_map]; gateRoleKey(name));
  GateDedupMembership([], mapped, target);
  if target in gateRoleNames(names) {
    assert target in mapped;
    var index :| 0 <= index < |mapped| && mapped[index] == target;
    assert gateRoleKey(names[index]) == target;
    assert names[index] in names;
  }
  if exists original :: original in names && gateRoleKey(original) == target {
    var original :| original in names && gateRoleKey(original) == target;
    var index :| 0 <= index < |names| && names[index] == original;
    assert mapped[index] == target;
  }
}

lemma lawGateAlternativesCombineBothLists_ensures(userRoles: seq<string>, roles: seq<string>, anyOf: seq<string>)
  ensures (lawGateAlternativesCombineBothLists(userRoles, roles, anyOf) == true)
{
  GateAlternativesLawView(userRoles, roles, anyOf);
  var merged := roles + ProofLib.Filter((set_x: string) => !((set_x in roles)), anyOf);
  ProofLib.FilterNil((set_x: string) => !((set_x in merged)), []);
  var extended := merged + ProofLib.Filter((set_x: string) => !((set_x in merged)), []);
  assert extended == merged;
  var callers := gateRoleNames(userRoles);
  var left := gateRoleNames(merged);
  var right := gateRoleNames(extended);
  forall name: string
    ensures (name in left) == (name in right)
  {
    GateRoleNameMembership(merged, name);
    GateRoleNameMembership(extended, name);
  }
  if |left| > 0 { assert left[0] in right; }
  if |right| > 0 { assert right[0] in left; }
  assert (|left| == 0) == (|right| == 0);
  ProofLib.FilterSamePredicate((set_x: string) => (set_x in left), (set_x: string) => (set_x in right), callers);
}

lemma lawGateMembershipDoesNotFollowRank_ensures(userRoles: seq<string>, required: string)
  ensures (lawGateMembershipDoesNotFollowRank(userRoles, required) == true)
{
  reveal lawGateMembershipDoesNotFollowRank();
  GateRoleNameMembership([required], gateRoleKey(required));
  assert gateRoleKey(required) in gateRoleNames([required]);
  GateAllowedView(true, userRoles, [], [], [required], [], "");
  if !(gateRoleKey(required) in gateRoleNames(userRoles)) {
    assert exists set_x :: set_x in gateRoleNames([required]) && !(set_x in gateRoleNames(userRoles));
    assert !roleGateAllowed(true, userRoles, [], [], [required], [], "");
  }
}

lemma lawBlankGateRoleRemainsAMembership_ensures(userRoles: seq<string>)
  ensures (lawBlankGateRoleRemainsAMembership(userRoles) == true)
{
  reveal lawBlankGateRoleRemainsAMembership();
  GateBlankMembership(userRoles);
  GateRoleNamesEmpty();
  GateAllowedView(true, userRoles, [], [""], [], [], "");
  var unionPredicate: string -> bool := (set_x: string) => !((set_x in []));
  ProofLib.FilterCons(unionPredicate, [""]);
  ProofLib.FilterNil(unionPredicate, []);
  assert ProofLib.Filter(unionPredicate, [""]) == [""];
  var callers := gateRoleNames(userRoles);
  var alternativeInputs := [] + ProofLib.Filter(unionPredicate, [""]);
  assert alternativeInputs == [""];
  var alternatives := gateRoleNames(alternativeInputs);
  forall name: string
    ensures (name in alternatives) == (name == "")
  {
    GateRoleNameMembership(alternativeInputs, name);
  }
  assert "" in alternatives;
  ProofLib.FilterNone((set_x: string) => (set_x in gateRoleNames([])), callers);
  var selected := ProofLib.Filter((set_x: string) => (set_x in alternatives), callers);
  if "" in callers {
    ProofLib.FilterMember((set_x: string) => (set_x in alternatives), callers, "");
    assert "" in selected;
    assert |selected| > 0;
  }
  if |selected| > 0 {
    var name := selected[0];
    ProofLib.FilterMember((set_x: string) => (set_x in alternatives), callers, name);
    assert name in alternatives;
    assert name == "";
    assert "" in callers;
  }
}

lemma GateAlternativesLawView(userRoles: seq<string>, roles: seq<string>, anyOf: seq<string>)
  ensures lawGateAlternativesCombineBothLists(userRoles, roles, anyOf) ==
    (var callers := gateRoleNames(userRoles);
     var merged := roles + ProofLib.Filter((set_x: string) => !((set_x in roles)), anyOf);
     var left := gateRoleNames(merged);
     var right := gateRoleNames(merged + ProofLib.Filter((set_x: string) => !((set_x in merged)), []));
     var empty := gateRoleNames([]);
     var common := |ProofLib.Filter((set_x: string) => (set_x in empty), callers)| == 0 &&
       (gateRoleRank("") == 0 || exists role :: role in callers && gateRoleRank(role) >= gateRoleRank("")) &&
       !(exists set_x :: set_x in empty && !(set_x in callers));
     (common && (|left| == 0 || |ProofLib.Filter((set_x: string) => (set_x in left), callers)| > 0)) ==
       (common && (|right| == 0 || |ProofLib.Filter((set_x: string) => (set_x in right), callers)| > 0)))
{
  reveal lawGateAlternativesCombineBothLists(), roleGateAllowed(), ProofLib.Filter();
}

lemma GateRoleNamesEmpty()
  ensures gateRoleNames([]) == []
{
  reveal gateRoleNames(), Std.Collections.Seq.FoldLeft();
}

lemma GateAllowedView(gatePresent: bool, userRoles: seq<string>, roles: seq<string>, anyOf: seq<string>, allOf: seq<string>, noneOf: seq<string>, minimum: string)
  ensures roleGateAllowed(gatePresent, userRoles, roles, anyOf, allOf, noneOf, minimum) ==
    (var callers := gateRoleNames(userRoles);
     var alternatives := gateRoleNames(roles + ProofLib.Filter((set_x: string) => !((set_x in roles)), anyOf));
     var requiredNames := gateRoleNames(allOf);
     var excludedNames := gateRoleNames(noneOf);
     var minimumRank := gateRoleRank(minimum);
     !gatePresent || (|ProofLib.Filter((set_x: string) => (set_x in excludedNames), callers)| == 0 &&
       (minimumRank == 0 || exists role :: role in callers && gateRoleRank(role) >= minimumRank) &&
       (|alternatives| == 0 || |ProofLib.Filter((set_x: string) => (set_x in alternatives), callers)| > 0) &&
       !(exists set_x :: set_x in requiredNames && !(set_x in callers))))
{
  reveal roleGateAllowed(), ProofLib.Filter();
}
