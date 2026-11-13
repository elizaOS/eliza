// replaceDurableDraft and sameDraft over two isolated binding slots and two
// writers. Up to two successful revisions per slot; no revision is reused.
module DurableDraftModel {
  const writers: Set[int]
  const bindings: Set[int]
  type Row = {
    binding: int,
    revision: int,
    text: int,
    sending: bool
  }
  pure val emptyRow = {
    binding: 0,
    revision: 0,
    text: 0,
    sending: false
  }
  var s: {
    rows: int -> Row,
    receipts: int -> Row,
    previous: int -> Row,
    event: str,
    writer: int,
    binding: int,
    text: int,
    mark: bool,
    accepted: bool,
    unchanged: bool
  }
  action init = s' = {
    rows: bindings.mapBy(_ => emptyRow),
    receipts: writers.mapBy(_ => emptyRow),
    previous: bindings.mapBy(_ => emptyRow),
    event: "init",
    writer: 1,
    binding: 1,
    text: 0,
    mark: false,
    accepted: false,
    unchanged: false
  }
  action read(w: int, b: int): bool = s' = s
    .with("receipts", s.receipts.set(w, s.rows.get(b)))
    .with("event", "read")
    .with("writer", w)
    .with("binding", b)
  action save(w: int, b: int, text: int, mark: bool): bool = {
    val actual = s.rows.get(b)
    val expected = s.receipts.get(w)
    val accepted = actual == expected and (expected.binding == 0 or expected.binding == b)
    val unchanged = actual.revision != 0 and actual.text == text and actual.sending == mark
    all {
      not(accepted) or unchanged or actual.revision < 2,
      s' = s
        .with("previous", s.rows)
        .with("rows", if (not(accepted) or unchanged) s.rows else s.rows.set(b, {
        binding: b, revision: actual.revision + 1, text: text, sending: mark
      }))
        .with("receipts", if (not(accepted)) s.receipts else s.receipts.set(w,
      if (unchanged) actual else {
        binding: b, revision: actual.revision + 1, text: text, sending: mark
      }))
        .with("event", "save")
        .with("writer", w)
        .with("binding", b)
        .with("text", text)
        .with("mark", mark)
        .with("accepted", accepted)
        .with("unchanged", unchanged)
    }
  }
  action step = {
    nondet w = writers.oneOf()
    nondet b = bindings.oneOf()
    nondet text = Set(0, 1, 2).oneOf()
    nondet mark = Set(true, false).oneOf()
    any {
      read(w, b),
      save(w, b, text, mark)
    }
  }
  val invariant = and {
    bindings.forall(b => s.rows.get(b).revision == 0 or s.rows.get(b).binding == b),
    (s.event == "save" and not(s.accepted)) implies s.rows == s.previous,
    (s.event == "save") implies bindings.forall(b => b == s.binding or s.rows.get(b) == s.previous.get(b)),
    (s.event == "save" and s.accepted and s.unchanged) implies s.rows == s.previous,
    (s.event == "save" and s.accepted and not(s.unchanged)) implies s.rows.get(s.binding).revision == s.previous.get(s.binding).revision + 1
  }
}

// Concurrent updates to one slot, including stale receipts after a clear.
module DurableDraftCAS {
  import DurableDraftModel(writers = Set(1, 2), bindings = Set(1)).*
}

// A writer switching identities cannot use one binding's receipt on another.
module DurableDraftIsolation {
  import DurableDraftModel(writers = Set(1), bindings = Set(1, 2)).*
}
