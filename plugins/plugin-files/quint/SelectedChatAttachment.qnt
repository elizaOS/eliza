/// One selected-file read. Owner/conversation binding remains the host's boundary.
module SelectedChatAttachment {
  var s: { phase: str, purpose: str, size: int, revision: int, selectedRevision: int, grant: bool, published: bool }
  action init = s' = { phase: "idle", purpose: "mail", size: 0, revision: 0, selectedRevision: 0, grant: false, published: false }
  action chooseFile(purpose: str, byteCount: int): bool = all { s.phase == "idle",
    s' = { ...s, phase: "selected", purpose: purpose, size: byteCount, grant: true, selectedRevision: s.revision } }
  action read = all { s.phase == "selected", s' = { ...s, phase: "reading" } }
  action revoke = all { s.phase == "reading", s' = { ...s, grant: false } }
  action change = all { s.phase == "reading", s' = { ...s, revision: 1 } }
  val valid = s.grant and s.revision == s.selectedRevision and s.size <= (if(s.purpose == "chat") 20 else 5)
  action settle = all { s.phase == "reading", s' = { ...s, phase: "settled", published: valid } }
  action cancel = all { s.phase == "reading", s' = { ...s, phase: "cancelled", grant: false } }
  action step = any { chooseFile("mail", 6), chooseFile("chat", 6), chooseFile("chat", 21), read, revoke, change, settle, cancel, s'=s }
  val safety = s.published implies s.phase == "settled" and valid
  temporal Completes = settle.weakFair(s) implies always(s.phase == "reading" implies eventually(s.phase != "reading"))
  run chatTest = init.then(chooseFile("chat", 6)).then(read).then(settle).expect(s.published and safety)
  run mailTest = init.then(chooseFile("mail", 6)).then(read).then(settle).expect(not(s.published) and safety)
  run revokedTest = init.then(chooseFile("chat", 6)).then(read).then(revoke).then(settle).expect(not(s.published) and safety)
  run staleTest = init.then(chooseFile("chat", 6)).then(read).then(change).then(settle).expect(not(s.published) and safety)
}
