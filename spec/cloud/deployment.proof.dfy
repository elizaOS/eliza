lemma lawStagingChangeRetiresStoredCredentials_ensures(p: Profile, api: string)
  ensures (lawStagingChangeRetiresStoredCredentials(p, api) == true)
{
  assert storageNamespace(p)[5] == p.staging.api;
  assert storageNamespace(p.(staging := p.staging.(api := api)))[5] == api;
}
