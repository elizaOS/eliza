// Proofs of the kernel's laws about nextNumber. nextNumber is one more than a
// running maximum over `seen` that starts at `stored`; ProofLib.FoldLeftMax
// states that such a maximum is at least its start and every element. The
// lambda is the one the generated nextNumber folds with, copied verbatim.

lemma lawNextIsAboveTheCounter_ensures(seen: seq<int>, stored: int)
  ensures (lawNextIsAboveTheCounter(seen, stored) == true)
{
  ProofLib.FoldLeftMax((top: int, x: int) => (if (x > top) then x else top), stored, seen);
}

lemma lawNextIsAboveEverythingSeen_ensures(seen: seq<int>, stored: int)
  ensures (lawNextIsAboveEverythingSeen(seen, stored) == true)
{
  ProofLib.FoldLeftMax((top: int, x: int) => (if (x > top) then x else top), stored, seen);
}

// pageStart beyond the end is (total - 1) / pageSize whole pages, which is a whole number of pages and the last
// start before total. Dafny needs the multiplication facts spelled out.
lemma lawAPageBeyondTheEndIsTheFinalPage_ensures(total: int, page: int, pageSize: int)
  ensures (lawAPageBeyondTheEndIsTheFinalPage(total, page, pageSize) == true)
{
  if total > 0 && pageSize >= 1 && page * pageSize >= total {
    if page <= 0 {
      KMulMono(page, 0, pageSize);
    }
    var q := (total - 1) / pageSize;
    assert quotient_kernel(total - 1, pageSize) == q;
    var start := q * pageSize;
    assert pageStart(total, page, pageSize) == start;
    assert total - 1 == q * pageSize + (total - 1) % pageSize;
    assert start + pageSize >= total;
    KMulDiv(q, pageSize);
    assert quotient_kernel(start, pageSize) == q;
  }
}

lemma KMulMono(a: int, c: int, b: int)
  requires a <= c && b >= 0
  ensures a * b <= c * b
{
  assert c * b - a * b == (c - a) * b;
}

lemma KMulDiv(q: int, b: int)
  requires q >= 0 && b >= 1
  ensures q * b >= 0 && (q * b) / b == q
{
  KMulMono(0, q, b);
  var r := (q * b) / b;
  var m := (q * b) % b;
  assert q * b == r * b + m && 0 <= m < b;
  if r < q {
    KMulMono(r + 1, q, b);
    assert (r + 1) * b == r * b + b;
  } else if r > q {
    KMulMono(q + 1, r, b);
    assert (q + 1) * b == q * b + b;
  }
}
