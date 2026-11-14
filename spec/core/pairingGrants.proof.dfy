lemma GrantKeysAndOwnersDistinct(s: PairingGrants)
  requires alwaysCanonicalGrantIndexesAgree(s)
  ensures ProofLib.DistinctBy(s.rows, (row: GrantRow) => row.key)
  ensures ProofLib.DistinctBy(s.rows, (row: GrantRow) => row.owner)
  ensures forall row :: row in s.rows ==> row.key != ""
{
  var rows := s.rows;
  reveal alwaysCanonicalGrantIndexesAgree(), ProofLib.Filter(), ProofLib.DistinctBy();
  forall i | 0 <= i < |rows|
    ensures forall j :: 0 <= j < |rows| && j != i ==> rows[j].key != rows[i].key && rows[j].owner != rows[i].owner
  {
    var pk := (other: GrantRow) => other.key == rows[i].key;
    var po := (other: GrantRow) => other.owner == rows[i].owner;
    assert rows[i] in rows;
    assert |ProofLib.Filter(pk, rows)| == 1 && |ProofLib.Filter(po, rows)| == 1;
    ProofLib.FilterCountOneIffUnique(pk, rows, (other: GrantRow) => other.key, i);
    ProofLib.FilterCountOneIffUnique(po, rows, (other: GrantRow) => other.owner, i);
  }
}

lemma GrantIndexesAgree(s: PairingGrants)
  requires ProofLib.DistinctBy(s.rows, (row: GrantRow) => row.key)
  requires ProofLib.DistinctBy(s.rows, (row: GrantRow) => row.owner)
  requires forall row :: row in s.rows ==> row.key != ""
  ensures alwaysCanonicalGrantIndexesAgree(s)
{
  reveal alwaysCanonicalGrantIndexesAgree(), ProofLib.Filter(), ProofLib.DistinctBy();
  forall row | row in s.rows
    ensures row.key != "" &&
      |ProofLib.Filter((other: GrantRow) => other.key == row.key, s.rows)| == 1 &&
      |ProofLib.Filter((other: GrantRow) => other.owner == row.owner, s.rows)| == 1
  {
    var i :| 0 <= i < |s.rows| && s.rows[i] == row;
    ProofLib.FilterCountOneIffUnique((other: GrantRow) => other.key == row.key, s.rows, (other: GrantRow) => other.key, i);
    ProofLib.FilterCountOneIffUnique((other: GrantRow) => other.owner == row.owner, s.rows, (other: GrantRow) => other.owner, i);
  }
}

lemma GrantCanonicalLookup(s: PairingGrants, owner: core__pairingAdmission_PairingScope)
  requires alwaysCanonicalGrantIndexesAgree(s)
  ensures grantAt(s, owner).key != "" ==> grantAt(s, owner) in s.rows && grantAt(s, owner).owner == owner
  ensures grantAt(s, owner).key == "" ==> forall row :: row in s.rows ==> row.owner != owner
{
  var p := (row: GrantRow) => row.owner == owner;
  var rows := ProofLib.Filter(p, s.rows);
  reveal grantAt(), ProofLib.Filter(), alwaysCanonicalGrantIndexesAgree();
  if |rows| > 0 {
    assert rows[0] in rows;
    ProofLib.FilterMember(p, s.rows, rows[0]);
    assert rows[0].key != "";
  } else if exists row :: row in s.rows && row.owner == owner {
    var row :| row in s.rows && row.owner == owner;
    ProofLib.FilterMember(p, s.rows, row);
    assert row in rows;
  }
}

lemma writeGrant_ensures(s: PairingGrants, request: GrantWrite)
  ensures (inv(s) ==> canWriteGrant(s, request) ==> alwaysCanonicalGrantIndexesAgree(writeGrant(s, request)))
  ensures (inv(s) ==> canWriteGrant(s, request) ==> alwaysGrantReceiptNamesStoredOwner(writeGrant(s, request)))
  ensures (inv(s) ==> canWriteGrant(s, request) ==> stepExistingGrantDataRetained(s, "writeGrant", writeGrant(s, request)))
{
  if inv(s) && canWriteGrant(s, request) {
    var c := request.candidate;
    GrantCanonicalLookup(s, c.owner);
    var after := writeGrant(s, request);
    if grantAt(s, c.owner).key == "" && !(exists row :: row in s.rows && row.key == c.key) && request.ack.GrantRetained? {
      GrantKeysAndOwnersDistinct(s);
      var byKey := (row: GrantRow) => row.key;
      var byOwner := (row: GrantRow) => row.owner;
      ProofLib.DistinctByConcat(s.rows, [c], byKey);
      ProofLib.DistinctByConcat(s.rows, [c], byOwner);
      assert after.rows == s.rows + [c];
      assert forall row :: row in after.rows ==> row in s.rows || row == c;
      GrantIndexesAgree(after);
    }
  }
}

lemma removeGrant_ensures(s: PairingGrants, key: string)
  ensures (inv(s) ==> alwaysCanonicalGrantIndexesAgree(removeGrant(s, key)))
  ensures (inv(s) ==> alwaysGrantReceiptNamesStoredOwner(removeGrant(s, key)))
  ensures (inv(s) ==> stepExistingGrantDataRetained(s, "removeGrant", removeGrant(s, key)))
{
  if inv(s) {
    var after := removeGrant(s, key);
    var p := (row: GrantRow) => row.key != key;
    reveal removeGrant(), ProofLib.Filter();
    assert after.rows == ProofLib.Filter(p, s.rows);
    GrantKeysAndOwnersDistinct(s);
    ProofLib.FilterKeepsDistinctBy(p, s.rows, (row: GrantRow) => row.key);
    ProofLib.FilterKeepsDistinctBy(p, s.rows, (row: GrantRow) => row.owner);
    forall row | row in after.rows ensures row.key != "" {
      ProofLib.FilterMember(p, s.rows, row);
    }
    GrantIndexesAgree(after);
  }
}
