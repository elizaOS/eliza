// Normalized crop admission and one durable edit identity. Coordinates use quarters.
module PhotoCropGeometry {
  var s: { x: int, y: int, width: int, height: int, phase: str,
           savedX: int, savedY: int, copies: int }
  action init = {
    nondet x = (-1).to(4).oneOf()
    nondet y = (-1).to(4).oneOf()
    nondet width = 0.to(5).oneOf()
    nondet height = 0.to(5).oneOf()
    s' = {x: x, y: y, width: width, height: height, phase: "ready",
          savedX: -1, savedY: -1, copies: 0}
  }
  val valid = s.x >= 0 and s.y >= 0 and s.width > 0 and s.height > 0
    and s.x + s.width <= 4 and s.y + s.height <= 4
  action preview = all {
    s.phase == "ready",
    s' = {...s, phase: if (valid) "preview" else "refused"}
  }
  action save = all {
    s.phase == "preview",
    s' = {...s, phase: "saved", savedX: s.x, savedY: s.y, copies: 1}
  }
  action retry = all {
    s.phase == "saved",
    nondet requestedX = 0.to(4).oneOf()
    s' = {...s, x: requestedX}
  }
  action cancel = all {
    Set("ready", "preview").contains(s.phase),
    s' = {...s, phase: "closed"}
  }
  action step = any {preview, save, retry, cancel, s' = s}
  val NoDuplicateEdit = s.copies >= 0 and s.copies <= 1
  val SavedSelectionRetained = (s.copies == 1).implies(
    s.savedX >= 0 and s.savedY >= 0 and s.savedX + s.width <= 4
      and s.savedY + s.height <= 4)
  val RefusedNeverPublishes = (s.phase == "refused").implies(s.copies == 0)
  val safety = NoDuplicateEdit and SavedSelectionRetained and RefusedNeverPublishes
}
