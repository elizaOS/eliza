lemma FoldAnd<T>(f: (bool, T) -> bool, p: T -> bool, init: bool, xs: seq<T>)
  requires forall a, x :: f(a, x) == (a && p(x))
  ensures Std.Collections.Seq.FoldLeft(f, init, xs) == (init && forall i :: 0 <= i < |xs| ==> p(xs[i]))
{
  if |xs| > 0 { FoldAnd(f, p, f(init, xs[0]), xs[1..]); }
}

lemma lawMixedSignersAreRefused_ensures(variants: seq<string>, rows: seq<ApkRow>)
  ensures (lawMixedSignersAreRefused(variants, rows) == true)
{
  if (exists r :: r in rows && (exists q :: q in rows && (q.signer != r.signer))) && publishedManifestAdmitted(variants, rows) {
    var r :| r in rows && (exists q :: q in rows && (q.signer != r.signer));
    var q :| q in rows && q.signer != r.signer;
    var i :| 0 <= i < |rows| && rows[i] == r;
    FoldAnd((ok: bool, r: ApkRow) => ((((ok && (r.apkDigest != "")) && r.fresh_) && (r.signer != "")) && (|Std.Collections.Seq.Filter((q: ApkRow) => (q.signer != r.signer), rows)| == 0)),
      (r: ApkRow) => ((((r.apkDigest != "")) && r.fresh_) && (r.signer != "")) && (|Std.Collections.Seq.Filter((q: ApkRow) => (q.signer != r.signer), rows)| == 0), true, rows);
    ProofLib.FilterMember((x: ApkRow) => (x.signer != r.signer), rows, q);
    assert Std.Collections.Seq.Filter((x: ApkRow) => (x.signer != r.signer), rows) == Std.Collections.Seq.Filter((q: ApkRow) => (q.signer != rows[i].signer), rows);
  }
}
