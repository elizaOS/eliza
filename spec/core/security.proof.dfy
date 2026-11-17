lemma SpawnEnvFilter(env: seq<EnvEntry>)
  ensures lawSpawnEnvKeepsOrdinaryKeys(env) == !(exists e :: e in env && !(blockedForSpawn(e) || e in ProofLib.Filter((e: EnvEntry) => !(blockedForSpawn(e)), env)))
{
}

lemma lawSpawnEnvKeepsOrdinaryKeys_ensures(env: seq<EnvEntry>)
  ensures (lawSpawnEnvKeepsOrdinaryKeys(env) == true)
{
  SpawnEnvFilter(env);
  forall e | e in env
    ensures e in ProofLib.Filter((e: EnvEntry) => !(blockedForSpawn(e)), env) <==> !blockedForSpawn(e)
  {
    ProofLib.FilterMember((e: EnvEntry) => !(blockedForSpawn(e)), env, e);
  }
}

lemma lawOrdinaryFieldsAreLoggedUnchanged_ensures(logFields: seq<LogField>)
  ensures (lawOrdinaryFieldsAreLoggedUnchanged(logFields) == true)
{
  forall i | 0 <= i < |logFields| && !mustRedact(logFields[i])
    ensures logFields[i] in redactLine(logFields)
  {
    assert redactLine(logFields)[i] == logFields[i];
  }
}
