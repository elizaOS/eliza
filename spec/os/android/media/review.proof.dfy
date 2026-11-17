lemma ReviewPartitionLength(rows: seq<ReviewedMedia>)
  ensures |ProofLib.Filter((row: ReviewedMedia) => row.typedKey, rows)| + |ProofLib.Filter((row: ReviewedMedia) => !(row.typedKey), rows)| == |rows|
{
  if |rows| > 0 {
    ProofLib.FilterCons((row: ReviewedMedia) => row.typedKey, rows);
    ProofLib.FilterCons((row: ReviewedMedia) => !(row.typedKey), rows);
    ReviewPartitionLength(rows[1..]);
  }
}

lemma lawPartitionSendsEachRowToOneRoute_ensures(rows: seq<ReviewedMedia>)
  ensures (lawPartitionSendsEachRowToOneRoute(rows) == true)
{
  ReviewPartitionLength(rows);
  forall row | row in permittedPart(rows) ensures row.typedKey { ProofLib.FilterMember((row: ReviewedMedia) => row.typedKey, rows, row); }
  forall row | row in ownedPart(rows) ensures !row.typedKey { ProofLib.FilterMember((row: ReviewedMedia) => !(row.typedKey), rows, row); }
}
