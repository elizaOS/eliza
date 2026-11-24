// spec/video/index.md, "Manual English captions outrank automatic English captions and audio"
lemma VideoSelectWithLib(tracks: seq<ManualCaptionTrack>)
  ensures selectManualCaptionTrack(tracks) ==
    (var primary := ProofLib.Filter((track: ManualCaptionTrack) => (track.primaryEnglish && manualCaptionUsable(track)), tracks);
     var regional := ProofLib.Filter((track: ManualCaptionTrack) => (!(track.primaryEnglish) && manualCaptionUsable(track)), tracks);
     if (|primary| > 0) then primary[0]
     else if (|regional| > 0) then regional[0]
     else noManualCaptionTrack)
{
}

lemma lawAUsableEnglishTrackIsSelected_ensures(tracks: seq<ManualCaptionTrack>)
  ensures (lawAUsableEnglishTrackIsSelected(tracks) == true)
{
  VideoSelectWithLib(tracks);
  var p1 := (track: ManualCaptionTrack) => (track.primaryEnglish && manualCaptionUsable(track));
  var p2 := (track: ManualCaptionTrack) => (!(track.primaryEnglish) && manualCaptionUsable(track));
  var primary := ProofLib.Filter(p1, tracks);
  var regional := ProofLib.Filter(p2, tracks);
  ProofLib.FilterSamePredicate((track: ManualCaptionTrack) => (track.primaryEnglish && manualCaptionUsable(track)), p1, tracks);
  ProofLib.FilterSamePredicate((track: ManualCaptionTrack) => (!(track.primaryEnglish) && manualCaptionUsable(track)), p2, tracks);
  if |primary| > 0 {
    var chosen := primary[0];
    ProofLib.FilterMember(p1, tracks, chosen);
    assert chosen in tracks && manualCaptionUsable(chosen);
  } else if |regional| > 0 {
    var chosen := regional[0];
    ProofLib.FilterMember(p2, tracks, chosen);
    assert chosen in tracks && manualCaptionUsable(chosen);
  } else {
    assert !manualCaptionUsable(noManualCaptionTrack);
    forall track | track in tracks
      ensures !manualCaptionUsable(track)
    {
      if manualCaptionUsable(track) {
        if track.primaryEnglish {
          ProofLib.FilterMember(p1, tracks, track);
          assert track in primary;
        } else {
          ProofLib.FilterMember(p2, tracks, track);
          assert track in regional;
        }
      }
    }
  }
}
