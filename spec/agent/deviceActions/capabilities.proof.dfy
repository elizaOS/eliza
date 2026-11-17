lemma VocabularyFilter(review: contracts__deviceReviews_DeviceReviewType, capabilities: seq<string>)
  ensures lawEveryReviewIsServedByTheVocabulary(review, capabilities) == (!(contracts__deviceReviews_reviewCapabilityAvailable(review, capabilities)) || contracts__deviceReviews_reviewCapabilityAvailable(review, ProofLib.Filter((set_x: string) => (set_x in vocabulary), capabilities)))
{}

lemma lawEveryReviewIsServedByTheVocabulary_ensures(review: contracts__deviceReviews_DeviceReviewType, capabilities: seq<string>)
  ensures (lawEveryReviewIsServedByTheVocabulary(review, capabilities) == true)
{
  VocabularyFilter(review, capabilities);
  var keep := (set_x: string) => (set_x in vocabulary);
  forall c | c in [contracts__deviceReviews_availabilityCapability, contracts__deviceReviews_notesSearchCapability, contracts__deviceReviews_namedTargetCapability, contracts__deviceReviews_calendarNamedReadCapability, contracts__deviceReviews_notesRecordCapability, contracts__deviceReviews_calendarRecordCapability, contracts__deviceReviews_reminderRecordCapability, contracts__deviceReviews_reminderRecordCapabilityV2]
    ensures c in capabilities ==> c in ProofLib.Filter(keep, capabilities)
  {
    assert c in vocabulary;
    ProofLib.FilterMember(keep, capabilities, c);
  }
}
