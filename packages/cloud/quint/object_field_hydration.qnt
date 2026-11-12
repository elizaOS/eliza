// Full reads must not reinterpret a preview as the complete object-backed field.
// Pointer: 0 inline, 1 object+key, 2 object without key, 3 unknown, 4 inline+key.
module object_field_hydration {
  type State = { pointer: int, json: bool, full: bool, phase: str,
    body: str, complete: bool, preview: bool, called: bool }
  var s: State
  pure def fresh(pointer: int, json: bool, full: bool): State = {
    pointer: pointer, json: json, full: full, phase: "idle", body: "unsettled",
    complete: false, preview: false, called: false
  }
  action init = {
    nondet pointer = 0.to(4).oneOf()
    nondet json = Set(false, true).oneOf()
    nondet full = Set(false, true).oneOf()
    s' = fresh(pointer, json, full)
  }
  action beginRead = all {
    s.phase == "idle", s' = { ...s, phase: "checking", called: true }
  }
  action readInline = all {
    s.phase == "checking", s.full, s.pointer == 0,
    s' = { ...s, phase: "success", complete: true }
  }
  action readPreview = all {
    s.phase == "checking", not(s.full),
    s' = { ...s, phase: "success", preview: true }
  }
  action rejectPointer = all {
    s.phase == "checking", s.full, s.pointer >= 2,
    s' = { ...s, phase: "error" }
  }
  action beginObject = all {
    s.phase == "checking", s.full, s.pointer == 1,
    s' = { ...s, phase: "reading" }
  }
  action receive(body) = all {
    s.phase == "reading", body != "malformed" or s.json,
    s' = { ...s, phase: "validating", body: body }
  }
  action unavailable = all {
    s.phase == "reading", s' = { ...s, phase: "error" }
  }
  action publish = all {
    s.phase == "validating",
    s.body == "complete" or (s.body == "empty" and not(s.json)),
    s' = { ...s, phase: "success", complete: true }
  }
  action rejectBody = all {
    s.phase == "validating",
    s.body == "malformed" or (s.body == "empty" and s.json),
    s' = { ...s, phase: "error" }
  }
  action finish = any { readInline, readPreview, rejectPointer, beginObject,
    receive("complete"), receive("empty"), receive("malformed"), unavailable,
    publish, rejectBody }
  action step = any { beginRead, finish, s' = s }
  val fullSuccessIsComplete = s.full and s.phase == "success" implies
    s.complete and not(s.preview) and s.pointer <= 1
  val noFullPreviewFallback = s.full implies not(s.preview)
  val invalidPointerCannotSucceed = s.full and s.pointer >= 2 implies s.phase != "success"
  val safety = fullSuccessIsComplete and noFullPreviewFallback and invalidPointerCannotSucceed
  val settled = s.phase == "success" or s.phase == "error"
  temporal ReadSettles = finish.weakFair(s) implies always(s.called implies eventually(settled))

  action inlineInit = s' = fresh(0, false, true)
  action objectTextInit = s' = fresh(1, false, true)
  action objectJsonInit = s' = fresh(1, true, true)
  action missingKeyInit = s' = fresh(2, false, true)
  action unknownInit = s' = fresh(3, false, true)
  action previewInit = s' = fresh(1, false, false)
  run inlineCompleteTest = inlineInit.then(beginRead).then(readInline).expect(safety and s.complete)
  run objectTextCompleteTest = objectTextInit.then(beginRead).then(beginObject)
    .then(receive("complete")).then(publish).expect(safety and s.complete)
  run objectJsonCompleteTest = objectJsonInit.then(beginRead).then(beginObject)
    .then(receive("complete")).then(publish).expect(safety and s.complete)
  run emptyTextIsCompleteTest = objectTextInit.then(beginRead).then(beginObject)
    .then(receive("empty")).then(publish).expect(safety and s.complete)
  run emptyJsonIsRejectedTest = objectJsonInit.then(beginRead).then(beginObject)
    .then(receive("empty")).then(rejectBody).expect(safety and s.phase == "error")
  run absentObjectIsRejectedTest = objectTextInit.then(beginRead).then(beginObject)
    .then(unavailable).expect(safety and s.phase == "error")
  run missingPointerIsRejectedTest = missingKeyInit.then(beginRead).then(rejectPointer)
    .expect(safety and s.phase == "error")
  run unknownPointerIsRejectedTest = unknownInit.then(beginRead).then(rejectPointer)
    .expect(safety and s.phase == "error")
  run previewDoesNotReadObjectTest = previewInit.then(beginRead).then(readPreview)
    .expect(safety and s.preview and s.body == "unsettled")

  // Old compatibility reads converted both failures into successful previews.
  action oldFallback = s' = { ...s, phase: "success", preview: true }
  run oldMissingKeyFallbackWitnessTest = missingKeyInit.then(beginRead).then(oldFallback)
    .expect(not(safety))
  run oldMissingObjectFallbackWitnessTest = objectTextInit.then(beginRead).then(beginObject)
    .then(oldFallback).expect(not(safety))
}
