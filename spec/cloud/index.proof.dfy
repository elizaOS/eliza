lemma lawInferenceStreamFraming_ensures(deltas: seq<int>, ending: cloud__services__inference_StreamEnding, usageAsked: bool, usageReported: bool)
  ensures (lawInferenceStreamFraming(deltas, ending, usageAsked, usageReported) == true)
{
  cloud__services__inference_lawEveryUnbrokenStreamEndsInOneDone_ensures(deltas, ending, usageAsked, usageReported);
  cloud__services__inference_lawOnlyAFinishedStreamCompletes_ensures(deltas, ending, usageAsked, usageReported);
  cloud__services__inference_lawUsageIsSentOnceAndOnlyAsReported_ensures(deltas, ending, usageAsked, usageReported);
  cloud__services__inference_lawOnlyAFailedStreamSendsAnError_ensures(deltas, ending, usageAsked, usageReported);
}

lemma lawInferenceStreamChunking_ensures(first: seq<int>, second: seq<int>)
  ensures (lawInferenceStreamChunking(first, second) == true)
{
  cloud__services__inference_lawChunkBoundariesDoNotChangeEvents_ensures(first, second);
}
