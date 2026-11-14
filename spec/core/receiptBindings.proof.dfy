lemma BindingFilters(s: BindingRegistry)
  ensures alwaysBindingObjectsAreUnique(s) == (s.nextObject > 0 && forall binding :: binding in s.bindings ==> binding.objectId > 0 && binding.objectId < s.nextObject && |ProofLib.Filter((other: BindingRecord) => (other.objectId == binding.objectId), s.bindings)| == 1)
  ensures alwaysContentIdentitiesAreUnique(s) == (forall content :: content in s.contents ==> content.contentId > 0 && |ProofLib.Filter((other: BoundContent) => (other.contentId == content.contentId), s.contents)| == 1 && (content.bindingId == 0 || exists binding :: binding in s.bindings && binding.objectId == content.bindingId))
{}

lemma BindingRecordDistinct(xs: seq<BindingRecord>)
  ensures (forall binding :: binding in xs ==> |ProofLib.Filter((other: BindingRecord) => (other.objectId == binding.objectId), xs)| == 1) <==> ProofLib.DistinctBy(xs, (binding: BindingRecord) => binding.objectId)
{
  if forall binding :: binding in xs ==> |ProofLib.Filter((other: BindingRecord) => (other.objectId == binding.objectId), xs)| == 1 {
    forall i, j | 0 <= i < |xs| && 0 <= j < |xs| && i != j
      ensures xs[i].objectId != xs[j].objectId
    {
      ProofLib.FilterCountOneIffUnique((other: BindingRecord) => (other.objectId == xs[i].objectId), xs, (binding: BindingRecord) => binding.objectId, i);
    }
  } else if ProofLib.DistinctBy(xs, (binding: BindingRecord) => binding.objectId) {
    forall binding | binding in xs ensures |ProofLib.Filter((other: BindingRecord) => (other.objectId == binding.objectId), xs)| == 1 {
      var i :| 0 <= i < |xs| && xs[i] == binding;
      ProofLib.FilterOne((other: BindingRecord) => (other.objectId == binding.objectId), xs, i);
    }
  }
}

lemma ContentRecordDistinct(xs: seq<BoundContent>)
  ensures (forall content :: content in xs ==> |ProofLib.Filter((other: BoundContent) => (other.contentId == content.contentId), xs)| == 1) <==> ProofLib.DistinctBy(xs, (content: BoundContent) => content.contentId)
{
  if forall content :: content in xs ==> |ProofLib.Filter((other: BoundContent) => (other.contentId == content.contentId), xs)| == 1 {
    forall i, j | 0 <= i < |xs| && 0 <= j < |xs| && i != j
      ensures xs[i].contentId != xs[j].contentId
    {
      ProofLib.FilterCountOneIffUnique((other: BoundContent) => (other.contentId == xs[i].contentId), xs, (content: BoundContent) => content.contentId, i);
    }
  } else if ProofLib.DistinctBy(xs, (content: BoundContent) => content.contentId) {
    forall content | content in xs ensures |ProofLib.Filter((other: BoundContent) => (other.contentId == content.contentId), xs)| == 1 {
      var i :| 0 <= i < |xs| && xs[i] == content;
      ProofLib.FilterOne((other: BoundContent) => (other.contentId == content.contentId), xs, i);
    }
  }
}

lemma ContentLookup(s: BindingRegistry, content: BoundContent)
  requires alwaysContentIdentitiesAreUnique(s)
  requires content in s.contents
  ensures contentAt(s, content.contentId) == content
{
  BindingFilters(s);
  var matches := ProofLib.Filter((other: BoundContent) => (other.contentId == content.contentId), s.contents);
  ProofLib.FilterMember((other: BoundContent) => (other.contentId == content.contentId), s.contents, content);
  assert |matches| == 1;
  assert matches[0] == content;
}

lemma ContentAtSummary(s: BindingRegistry, contentId: int)
  ensures contentAt(s, contentId) == emptyContent || (contentAt(s, contentId) in s.contents && contentAt(s, contentId).contentId == contentId)
{
  var matches := ProofLib.Filter((content: BoundContent) => (content.contentId == contentId), s.contents);
  if |matches| > 0 {
    ProofLib.FilterMember((content: BoundContent) => (content.contentId == contentId), s.contents, matches[0]);
  }
}

lemma BindingAppendAndRemap(s: BindingRegistry, after: BindingRegistry, added: BindingRecord, contentId: int)
  requires inv(s)
  requires added.objectId == s.nextObject
  requires after.bindings == s.bindings + [added]
  requires after.nextObject == s.nextObject + 1
  requires |after.contents| == |s.contents|
  requires forall i :: 0 <= i < |s.contents| ==> after.contents[i] == (if s.contents[i].contentId == contentId then s.contents[i].(bindingId := s.nextObject) else s.contents[i])
  requires forall reference :: reference in after.authentic ==> reference in s.authentic || reference == s.nextObject
  ensures alwaysBindingObjectsAreUnique(after)
  ensures alwaysContentIdentitiesAreUnique(after)
  ensures alwaysAuthenticReferencesAreBound(after)
{
  BindingFilters(s);
  BindingFilters(after);
  BindingRecordDistinct(s.bindings);
  forall binding | binding in s.bindings ensures binding.objectId != added.objectId {}
  ProofLib.DistinctByConcat(s.bindings, [added], (binding: BindingRecord) => binding.objectId);
  BindingRecordDistinct(after.bindings);
  ContentRecordDistinct(s.contents);
  forall i, j | 0 <= i < |after.contents| && 0 <= j < |after.contents| && i != j
    ensures after.contents[i].contentId != after.contents[j].contentId
  {}
  assert ProofLib.DistinctBy(after.contents, (content: BoundContent) => content.contentId);
  ContentRecordDistinct(after.contents);
  forall content | content in after.contents
    ensures content.contentId > 0 && (content.bindingId == 0 || exists binding :: binding in after.bindings && binding.objectId == content.bindingId)
  {
    var i :| 0 <= i < |after.contents| && after.contents[i] == content;
    var prior := s.contents[i];
    if prior.contentId == contentId {
      assert added in after.bindings;
    } else if prior.bindingId != 0 {
      var binding :| binding in s.bindings && binding.objectId == prior.bindingId;
      assert binding in after.bindings;
    }
  }
  forall reference | reference in after.authentic
    ensures reference > 0 && reference < after.nextObject && exists binding :: binding in after.bindings && binding.objectId == reference
  {
    if reference in s.authentic {
      var binding :| binding in s.bindings && binding.objectId == reference;
      assert binding in after.bindings;
    } else {
      assert reference == s.nextObject;
      assert added in after.bindings;
    }
  }
}

lemma bindContent_ensures(s: BindingRegistry, by_: BindingCaller, contentId: int, text: string, receiptIds: seq<string>, applied: bool)
  ensures (inv(s) ==> canBindContent(s, by_, contentId, text, receiptIds, applied) ==> alwaysBindingObjectsAreUnique(bindContent(s, by_, contentId, text, receiptIds, applied)))
  ensures (inv(s) ==> canBindContent(s, by_, contentId, text, receiptIds, applied) ==> alwaysContentIdentitiesAreUnique(bindContent(s, by_, contentId, text, receiptIds, applied)))
  ensures (inv(s) ==> canBindContent(s, by_, contentId, text, receiptIds, applied) ==> alwaysAuthenticReferencesAreBound(bindContent(s, by_, contentId, text, receiptIds, applied)))
{
  if inv(s) && canBindContent(s, by_, contentId, text, receiptIds, applied) {
    var after := bindContent(s, by_, contentId, text, receiptIds, applied);
    forall reference | reference in after.authentic
      ensures reference in s.authentic || reference == s.nextObject
    {
      if !(reference in s.authentic) {
        ProofLib.FilterMember((set_x: int) => !((set_x in s.authentic)), [s.nextObject], reference);
      }
    }
    BindingAppendAndRemap(s, after, BindingRecord(s.nextObject, text, receiptIds, applied), contentId);
  }
}

lemma forgeCopiedBinding_ensures(s: BindingRegistry, contentId: int)
  ensures (inv(s) ==> canForgeCopiedBinding(s, contentId) ==> alwaysBindingObjectsAreUnique(forgeCopiedBinding(s, contentId)))
  ensures (inv(s) ==> canForgeCopiedBinding(s, contentId) ==> alwaysContentIdentitiesAreUnique(forgeCopiedBinding(s, contentId)))
  ensures (inv(s) ==> canForgeCopiedBinding(s, contentId) ==> alwaysAuthenticReferencesAreBound(forgeCopiedBinding(s, contentId)))
{
  if inv(s) && canForgeCopiedBinding(s, contentId) {
    var after := forgeCopiedBinding(s, contentId);
    BindingAppendAndRemap(s, after, bindingAt(s, contentId).(objectId := s.nextObject), contentId);
  }
}

lemma lawCopiedBindingCannotAuthenticate_ensures(s: BindingRegistry, contentId: int)
  ensures (lawCopiedBindingCannotAuthenticate(s, contentId) == true)
{
  if validBindingState(s) && canForgeCopiedBinding(s, contentId) {
    BindingFilters(s);
    ContentAtSummary(s, contentId);
    var original := contentAt(s, contentId);
    if original == emptyContent {
      ProofLib.FilterNone((binding: BindingRecord) => (binding.objectId == contentAt(s, contentId).bindingId), s.bindings);
      assert bindingAt(s, contentId) == emptyBinding;
      assert false;
    }
    var i :| 0 <= i < |s.contents| && s.contents[i] == original;
    var after := forgeCopiedBinding(s, contentId);
    forgeCopiedBinding_ensures(s, contentId);
    ContentLookup(after, after.contents[i]);
    assert contentAt(after, contentId).bindingId == s.nextObject;
    assert !(s.nextObject in s.authentic);
  }
}

lemma lawSerializationDropsAuthority_ensures(s: BindingRegistry, contentId: int, copyId: int)
  ensures (lawSerializationDropsAuthority(s, contentId, copyId) == true)
{
  if validBindingState(s) && canSerializeContent(s, contentId, copyId) {
    var after := serializeContent(s, contentId, copyId);
    serializeContent_ensures(s, contentId, copyId);
    var copied := contentAt(s, contentId).(contentId := copyId, bindingId := 0);
    assert copied in after.contents;
    ContentLookup(after, copied);
    assert !(0 in s.authentic);
  }
}

lemma lawStrippingRemovesProof_ensures(s: BindingRegistry, contentId: int)
  ensures (lawStrippingRemovesProof(s, contentId) == true)
{
  if validBindingState(s) && canStripBinding(s, contentId) {
    var original := contentAt(s, contentId);
    ContentAtSummary(s, contentId);
    assert original in s.contents;
    var i :| 0 <= i < |s.contents| && s.contents[i] == original;
    var after := stripBinding(s, contentId);
    stripBinding_ensures(s, contentId);
    ContentLookup(after, after.contents[i]);
    assert !contentAt(after, contentId).idsPresent;
  }
}

lemma ContentRemapPreservesRegistry(s: BindingRegistry, after: BindingRegistry)
  requires inv(s)
  requires after.bindings == s.bindings && after.authentic == s.authentic && after.nextObject == s.nextObject
  requires |after.contents| == |s.contents|
  requires forall i :: 0 <= i < |s.contents| ==> after.contents[i].contentId == s.contents[i].contentId && (after.contents[i].bindingId == 0 || after.contents[i].bindingId == s.contents[i].bindingId)
  ensures alwaysBindingObjectsAreUnique(after)
  ensures alwaysContentIdentitiesAreUnique(after)
  ensures alwaysAuthenticReferencesAreBound(after)
{
  BindingFilters(s);
  BindingFilters(after);
  ContentRecordDistinct(s.contents);
  forall i, j | 0 <= i < |after.contents| && 0 <= j < |after.contents| && i != j
    ensures after.contents[i].contentId != after.contents[j].contentId
  {}
  assert ProofLib.DistinctBy(after.contents, (content: BoundContent) => content.contentId);
  ContentRecordDistinct(after.contents);
  forall content | content in after.contents
    ensures content.contentId > 0 && (content.bindingId == 0 || exists binding :: binding in after.bindings && binding.objectId == content.bindingId)
  {
    var i :| 0 <= i < |after.contents| && after.contents[i] == content;
  }
}

lemma ContentAppendPreservesRegistry(s: BindingRegistry, after: BindingRegistry, added: BoundContent)
  requires inv(s)
  requires after.bindings == s.bindings && after.authentic == s.authentic && after.nextObject == s.nextObject
  requires after.contents == s.contents + [added]
  requires added.contentId > 0
  requires forall prior :: prior in s.contents ==> prior.contentId != added.contentId
  requires added.bindingId == 0 || exists binding :: binding in s.bindings && binding.objectId == added.bindingId
  ensures alwaysBindingObjectsAreUnique(after)
  ensures alwaysContentIdentitiesAreUnique(after)
  ensures alwaysAuthenticReferencesAreBound(after)
{
  BindingFilters(s);
  BindingFilters(after);
  ContentRecordDistinct(s.contents);
  ProofLib.DistinctByConcat(s.contents, [added], (content: BoundContent) => content.contentId);
  ContentRecordDistinct(after.contents);
}

lemma createContent_ensures(s: BindingRegistry, contentId: int, text: string, receiptIds: seq<string>)
  ensures (inv(s) ==> canCreateContent(s, contentId, text, receiptIds) ==> alwaysBindingObjectsAreUnique(createContent(s, contentId, text, receiptIds)))
  ensures (inv(s) ==> canCreateContent(s, contentId, text, receiptIds) ==> alwaysContentIdentitiesAreUnique(createContent(s, contentId, text, receiptIds)))
  ensures (inv(s) ==> canCreateContent(s, contentId, text, receiptIds) ==> alwaysAuthenticReferencesAreBound(createContent(s, contentId, text, receiptIds)))
{
  if inv(s) && canCreateContent(s, contentId, text, receiptIds) {
    forall prior | prior in s.contents ensures prior.contentId != contentId {
      if prior.contentId == contentId {
        ContentLookup(s, prior);
        BindingFilters(s);
      }
    }
    ContentAppendPreservesRegistry(s, createContent(s, contentId, text, receiptIds), BoundContent(contentId, 0, text, receiptIds, true));
  }
}

lemma rewriteContent_ensures(s: BindingRegistry, contentId: int, text: string, receiptIds: seq<string>)
  ensures (inv(s) ==> canRewriteContent(s, contentId, text, receiptIds) ==> alwaysBindingObjectsAreUnique(rewriteContent(s, contentId, text, receiptIds)))
  ensures (inv(s) ==> canRewriteContent(s, contentId, text, receiptIds) ==> alwaysContentIdentitiesAreUnique(rewriteContent(s, contentId, text, receiptIds)))
  ensures (inv(s) ==> canRewriteContent(s, contentId, text, receiptIds) ==> alwaysAuthenticReferencesAreBound(rewriteContent(s, contentId, text, receiptIds)))
{
  if inv(s) && canRewriteContent(s, contentId, text, receiptIds) {
    ContentRemapPreservesRegistry(s, rewriteContent(s, contentId, text, receiptIds));
  }
}

lemma stripBinding_ensures(s: BindingRegistry, contentId: int)
  ensures (inv(s) ==> canStripBinding(s, contentId) ==> alwaysBindingObjectsAreUnique(stripBinding(s, contentId)))
  ensures (inv(s) ==> canStripBinding(s, contentId) ==> alwaysContentIdentitiesAreUnique(stripBinding(s, contentId)))
  ensures (inv(s) ==> canStripBinding(s, contentId) ==> alwaysAuthenticReferencesAreBound(stripBinding(s, contentId)))
{
  if inv(s) && canStripBinding(s, contentId) {
    ContentRemapPreservesRegistry(s, stripBinding(s, contentId));
  }
}

lemma spreadContent_ensures(s: BindingRegistry, contentId: int, copyId: int)
  ensures (inv(s) ==> canSpreadContent(s, contentId, copyId) ==> alwaysBindingObjectsAreUnique(spreadContent(s, contentId, copyId)))
  ensures (inv(s) ==> canSpreadContent(s, contentId, copyId) ==> alwaysContentIdentitiesAreUnique(spreadContent(s, contentId, copyId)))
  ensures (inv(s) ==> canSpreadContent(s, contentId, copyId) ==> alwaysAuthenticReferencesAreBound(spreadContent(s, contentId, copyId)))
{
  if inv(s) && canSpreadContent(s, contentId, copyId) {
    ContentAtSummary(s, contentId);
    BindingFilters(s);
    var original := contentAt(s, contentId);
    assert original in s.contents;
    forall prior | prior in s.contents ensures prior.contentId != copyId {
      if prior.contentId == copyId {
        ContentLookup(s, prior);
      }
    }
    ContentAppendPreservesRegistry(s, spreadContent(s, contentId, copyId), contentAt(s, contentId).(contentId := copyId));
  }
}

lemma serializeContent_ensures(s: BindingRegistry, contentId: int, copyId: int)
  ensures (inv(s) ==> canSerializeContent(s, contentId, copyId) ==> alwaysBindingObjectsAreUnique(serializeContent(s, contentId, copyId)))
  ensures (inv(s) ==> canSerializeContent(s, contentId, copyId) ==> alwaysContentIdentitiesAreUnique(serializeContent(s, contentId, copyId)))
  ensures (inv(s) ==> canSerializeContent(s, contentId, copyId) ==> alwaysAuthenticReferencesAreBound(serializeContent(s, contentId, copyId)))
{
  if inv(s) && canSerializeContent(s, contentId, copyId) {
    ContentAtSummary(s, contentId);
    BindingFilters(s);
    var original := contentAt(s, contentId);
    assert original in s.contents;
    forall prior | prior in s.contents ensures prior.contentId != copyId {
      if prior.contentId == copyId {
        ContentLookup(s, prior);
      }
    }
    ContentAppendPreservesRegistry(s, serializeContent(s, contentId, copyId), contentAt(s, contentId).(contentId := copyId, bindingId := 0));
  }
}
