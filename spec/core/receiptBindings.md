# Core-owned delivery binding registry

The source is `packages/core/src/runtime/effect-delivery.ts:13-98` at the pinned baseline. This aggregate owns the private WeakSet of binding object identities and the enumerable private-symbol associations on content objects. [Receipt settlement](./receipts.md) supplies the action-validated `applied` value. Strings here are already trimmed by the exact text normalization boundary. The `CoreAction` caller denotes the installed action-runtime capability; it is supplied separately from parsed external event data.

## Story: Preserve authentic binding identity across concurrent replies

### Distinct bindings retain exact ordered receipt IDs and text

```quint
type BindingCaller = CoreAction | ExternalBindingCaller
type BindingRecord = { objectId: int, text: str, receiptIds: List[str], applied: bool }
type BoundContent = { contentId: int, bindingId: int, text: str, receiptIds: List[str], idsPresent: bool }
type BindingRegistry = { bindings: List[BindingRecord], authentic: Set[int], contents: List[BoundContent], nextObject: int }
pure val initial: BindingRegistry = { bindings: List(), authentic: Set(), contents: List(), nextObject: 1 }
pure val emptyBinding: BindingRecord = { objectId: 0, text: "", receiptIds: List(), applied: false }
pure val emptyContent: BoundContent = { contentId: 0, bindingId: 0, text: "", receiptIds: List(), idsPresent: false }
pure val byValues = Set(CoreAction, ExternalBindingCaller)
pure val contentIdValues = Set(1, 2, 3)
pure val copyIdValues = Set(1, 2, 3)
pure val textValues = Set("confirmed", "rewritten", "")
pure val receiptIdsValues = Set(List(), List("r1"), List("r1", "r2"), List("r2", "r1"))
pure def contentAt(s: BindingRegistry, contentId: int): BoundContent = s.contents.select(content => content.contentId == contentId).nthOr(0, emptyContent)
pure def bindingAt(s: BindingRegistry, contentId: int): BindingRecord = s.bindings.select(binding => binding.objectId == contentAt(s, contentId).bindingId).nthOr(0, emptyBinding)
pure def canCreateContent(s: BindingRegistry, contentId: int, text: str, receiptIds: List[str]): bool = contentId > 0 and contentAt(s, contentId).contentId == 0
pure def createContent(s: BindingRegistry, contentId: int, text: str, receiptIds: List[str]): BindingRegistry = { ...s, contents: s.contents.append({ contentId: contentId, bindingId: 0, text: text, receiptIds: receiptIds, idsPresent: true }) }
pure def canBindContent(s: BindingRegistry, by: BindingCaller, contentId: int, text: str, receiptIds: List[str], applied: bool): bool = by == CoreAction and contentAt(s, contentId).contentId != 0
pure def bindContent(s: BindingRegistry, by: BindingCaller, contentId: int, text: str, receiptIds: List[str], applied: bool): BindingRegistry = { ...s, bindings: s.bindings.append({ objectId: s.nextObject, text: text, receiptIds: receiptIds, applied: applied }), authentic: s.authentic.union(Set(s.nextObject)), nextObject: s.nextObject + 1, contents: s.contents.listMap(content => if (content.contentId == contentId) { ...content, bindingId: s.nextObject } else content) }
pure def canSpreadContent(s: BindingRegistry, contentId: int, copyId: int): bool = contentAt(s, contentId).contentId != 0 and copyId > 0 and contentAt(s, copyId).contentId == 0
pure def spreadContent(s: BindingRegistry, contentId: int, copyId: int): BindingRegistry = { ...s, contents: s.contents.append({ ...contentAt(s, contentId), contentId: copyId }) }
pure def canSerializeContent(s: BindingRegistry, contentId: int, copyId: int): bool = canSpreadContent(s, contentId, copyId)
pure def serializeContent(s: BindingRegistry, contentId: int, copyId: int): BindingRegistry = { ...s, contents: s.contents.append({ ...contentAt(s, contentId), contentId: copyId, bindingId: 0 }) }
pure def canForgeCopiedBinding(s: BindingRegistry, contentId: int): bool = bindingAt(s, contentId).objectId != 0
pure def forgeCopiedBinding(s: BindingRegistry, contentId: int): BindingRegistry = { ...s, bindings: s.bindings.append({ ...bindingAt(s, contentId), objectId: s.nextObject }), nextObject: s.nextObject + 1, contents: s.contents.listMap(content => if (content.contentId == contentId) { ...content, bindingId: s.nextObject } else content) }
pure def canRewriteContent(s: BindingRegistry, contentId: int, text: str, receiptIds: List[str]): bool = contentAt(s, contentId).contentId != 0
pure def rewriteContent(s: BindingRegistry, contentId: int, text: str, receiptIds: List[str]): BindingRegistry = { ...s, contents: s.contents.listMap(content => if (content.contentId == contentId) { ...content, text: text, receiptIds: receiptIds, idsPresent: true } else content) }
pure def canStripBinding(s: BindingRegistry, contentId: int): bool = contentAt(s, contentId).contentId != 0
pure def stripBinding(s: BindingRegistry, contentId: int): BindingRegistry = { ...s, contents: s.contents.listMap(content => if (content.contentId == contentId) { ...content, bindingId: 0, idsPresent: false, receiptIds: List() } else content) }
pure def validBinding(s: BindingRegistry, contentId: int): bool = s.authentic.contains(contentAt(s, contentId).bindingId) and contentAt(s, contentId).idsPresent and contentAt(s, contentId).text == bindingAt(s, contentId).text and contentAt(s, contentId).receiptIds == bindingAt(s, contentId).receiptIds
pure def provesApplication(s: BindingRegistry, contentId: int): bool = validBinding(s, contentId) and bindingAt(s, contentId).applied and bindingAt(s, contentId).receiptIds.length() > 0
pure def alwaysBindingObjectsAreUnique(s: BindingRegistry): bool = s.nextObject > 0 and s.bindings.every(binding => binding.objectId > 0 and binding.objectId < s.nextObject and s.bindings.select(other => other.objectId == binding.objectId).length() == 1)
pure def alwaysContentIdentitiesAreUnique(s: BindingRegistry): bool = s.contents.every(content => content.contentId > 0 and s.contents.select(other => other.contentId == content.contentId).length() == 1 and (content.bindingId == 0 or s.bindings.some(binding => binding.objectId == content.bindingId)))
pure def alwaysAuthenticReferencesAreBound(s: BindingRegistry): bool = s.authentic.forall(reference => reference > 0 and reference < s.nextObject and s.bindings.some(binding => binding.objectId == reference))
pure def validBindingState(s: BindingRegistry): bool = alwaysBindingObjectsAreUnique(s) and alwaysContentIdentitiesAreUnique(s) and alwaysAuthenticReferencesAreBound(s)
pure def lawCopiedBindingCannotAuthenticate(s: BindingRegistry, contentId: int): bool = validBindingState(s) and canForgeCopiedBinding(s, contentId) implies not(validBinding(forgeCopiedBinding(s, contentId), contentId))
pure def lawSerializationDropsAuthority(s: BindingRegistry, contentId: int, copyId: int): bool = validBindingState(s) and canSerializeContent(s, contentId, copyId) implies not(validBinding(serializeContent(s, contentId, copyId), copyId))
pure def lawStrippingRemovesProof(s: BindingRegistry, contentId: int): bool = validBindingState(s) and canStripBinding(s, contentId) implies not(provesApplication(stripBinding(s, contentId), contentId))
pure def lawExternalCannotBind(s: BindingRegistry, contentId: int, text: str, receiptIds: List[str], applied: bool): bool = not(canBindContent(s, ExternalBindingCaller, contentId, text, receiptIds, applied))
pure def sometimesSeveralAuthenticBindings(s: BindingRegistry): bool = s.authentic.size() > 1
pure def sometimesCopiedFieldsFailAuthentication(s: BindingRegistry): bool = s.contents.some(content => content.bindingId > 0 and not(s.authentic.contains(content.bindingId)))
```
