lemma StorageStageIds(s: Store, id: string)
  ensures stage(s, id).stagedIds == s.stagedIds + ProofLib.Filter((set_x: string) => !((set_x in s.stagedIds)), [id])
{}

lemma stage_ensures(s: Store, id: string)
  ensures (inv(s) ==> canStage(s, id) ==> alwaysStagedIdentitiesMatchManifest(stage(s, id)))
  ensures (inv(s) ==> canStage(s, id) ==> alwaysPublicationHasDurability(stage(s, id)))
  ensures (inv(s) ==> canStage(s, id) ==> alwaysExposedPageHasCurrentAuthority(stage(s, id)))
  ensures (inv(s) ==> canStage(s, id) ==> stepCompleteDependenciesPrecedePublication(s, "stage", stage(s, id)))
  ensures (inv(s) ==> canStage(s, id) ==> stepFailedWritePreservesHead(s, "stage", stage(s, id)))
{
  if inv(s) && canStage(s, id) {
    StorageStageIds(s, id);
    var after := stage(s, id);
    forall candidate | candidate in after.stagedIds
      ensures candidate in s.requiredIds
    {
      if candidate in s.stagedIds {
        assert candidate in s.requiredIds;
      } else {
        assert candidate in ProofLib.Filter((set_x: string) => !((set_x in s.stagedIds)), [id]);
        ProofLib.FilterMember((set_x: string) => !((set_x in s.stagedIds)), [id], candidate);
        assert candidate == id;
      }
    }
  }
}
