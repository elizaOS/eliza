lemma choosePlan_ensures(s: PluginPlan, bundled: seq<string>, policy: agent__host__launch_LaunchPolicy, privacyOn: bool, workerLaunch: WorkerLaunch)
  ensures (inv(s) ==> canChoosePlan(s, bundled, policy, privacyOn, workerLaunch) ==> alwaysStorageThenCloudLinkLoadFirst(choosePlan(s, bundled, policy, privacyOn, workerLaunch)))
  ensures (inv(s) ==> canChoosePlan(s, bundled, policy, privacyOn, workerLaunch) ==> alwaysProductRegistersAfterEveryOtherPlugin(choosePlan(s, bundled, policy, privacyOn, workerLaunch)))
  ensures (inv(s) ==> canChoosePlan(s, bundled, policy, privacyOn, workerLaunch) ==> alwaysNextWithinPlan(choosePlan(s, bundled, policy, privacyOn, workerLaunch)))
  ensures (inv(s) ==> canChoosePlan(s, bundled, policy, privacyOn, workerLaunch) ==> alwaysPlannedPluginsAreAvailable(choosePlan(s, bundled, policy, privacyOn, workerLaunch)))
  ensures (inv(s) ==> canChoosePlan(s, bundled, policy, privacyOn, workerLaunch) ==> alwaysPrivacyServiceFollowsTheSwitch(choosePlan(s, bundled, policy, privacyOn, workerLaunch)))
  ensures (inv(s) ==> canChoosePlan(s, bundled, policy, privacyOn, workerLaunch) ==> alwaysNoPluginPlannedTwice(choosePlan(s, bundled, policy, privacyOn, workerLaunch)))
  ensures (inv(s) ==> canChoosePlan(s, bundled, policy, privacyOn, workerLaunch) ==> alwaysOnlyARegisteredProductHasRoutes(choosePlan(s, bundled, policy, privacyOn, workerLaunch)))
  ensures (inv(s) ==> canChoosePlan(s, bundled, policy, privacyOn, workerLaunch) ==> alwaysProductRoutesAvoidModuleRoutes(choosePlan(s, bundled, policy, privacyOn, workerLaunch)))
  ensures (inv(s) ==> canChoosePlan(s, bundled, policy, privacyOn, workerLaunch) ==> alwaysReadyLoadedTheWholePlan(choosePlan(s, bundled, policy, privacyOn, workerLaunch)))
  ensures (inv(s) ==> canChoosePlan(s, bundled, policy, privacyOn, workerLaunch) ==> alwaysWorkerGetsNoSecret(choosePlan(s, bundled, policy, privacyOn, workerLaunch)))
  ensures (inv(s) ==> canChoosePlan(s, bundled, policy, privacyOn, workerLaunch) ==> alwaysOnlyAVerifiedWorkerRuns(choosePlan(s, bundled, policy, privacyOn, workerLaunch)))
  ensures (inv(s) ==> canChoosePlan(s, bundled, policy, privacyOn, workerLaunch) ==> stepRefusalIsFinal(s, choosePlan(s, bundled, policy, privacyOn, workerLaunch)))
{
  if inv(s) && canChoosePlan(s, bundled, policy, privacyOn, workerLaunch) {
    if planPhase(bundled, policy).Registering? {
      ProfileLoadDistinct(policy);
      ProfilePlanDistinct(policy.pluginsLoad, privacyOn);
      assert choosePlan(s, bundled, policy, privacyOn, workerLaunch).order == planOrder(policy.pluginsLoad, privacyOn);
    }
  }
}

lemma spawnWorker_ensures(s: PluginPlan, offered: seq<ProcessValue>)
  ensures (inv(s) ==> canSpawnWorker(s, offered) ==> alwaysStorageThenCloudLinkLoadFirst(spawnWorker(s, offered)))
  ensures (inv(s) ==> canSpawnWorker(s, offered) ==> alwaysProductRegistersAfterEveryOtherPlugin(spawnWorker(s, offered)))
  ensures (inv(s) ==> canSpawnWorker(s, offered) ==> alwaysNextWithinPlan(spawnWorker(s, offered)))
  ensures (inv(s) ==> canSpawnWorker(s, offered) ==> alwaysPlannedPluginsAreAvailable(spawnWorker(s, offered)))
  ensures (inv(s) ==> canSpawnWorker(s, offered) ==> alwaysPrivacyServiceFollowsTheSwitch(spawnWorker(s, offered)))
  ensures (inv(s) ==> canSpawnWorker(s, offered) ==> alwaysNoPluginPlannedTwice(spawnWorker(s, offered)))
  ensures (inv(s) ==> canSpawnWorker(s, offered) ==> alwaysOnlyARegisteredProductHasRoutes(spawnWorker(s, offered)))
  ensures (inv(s) ==> canSpawnWorker(s, offered) ==> alwaysProductRoutesAvoidModuleRoutes(spawnWorker(s, offered)))
  ensures (inv(s) ==> canSpawnWorker(s, offered) ==> alwaysReadyLoadedTheWholePlan(spawnWorker(s, offered)))
  ensures (inv(s) ==> canSpawnWorker(s, offered) ==> alwaysWorkerGetsNoSecret(spawnWorker(s, offered)))
  ensures (inv(s) ==> canSpawnWorker(s, offered) ==> alwaysOnlyAVerifiedWorkerRuns(spawnWorker(s, offered)))
  ensures (inv(s) ==> canSpawnWorker(s, offered) ==> stepRefusalIsFinal(s, spawnWorker(s, offered)))
{
  if inv(s) && canSpawnWorker(s, offered) {
    ProfileSpawnFilter(s, offered);
    var plain := ProofLib.Filter((v: ProcessValue) => v.PlainSetting?, offered);
    forall v | v in spawnWorker(s, offered).workerEnv
      ensures v.PlainSetting?
    {
      if !(v in s.workerEnv) {
        ProofLib.FilterMember((set_x: ProcessValue) => !((set_x in s.workerEnv)), plain, v);
        ProofLib.FilterMember((v: ProcessValue) => v.PlainSetting?, offered, v);
      }
    }
  }
}

lemma lawAPinnedWorkerOwnsTheWorkerService_ensures(names: seq<string>)
  ensures (lawAPinnedWorkerOwnsTheWorkerService(names) == true)
{
  ProfileOwnedFilter(true);
  if !(workflowWorkerService in agentServiceNames) {
    ProofLib.FilterMember((set_x: string) => !((set_x in agentServiceNames)), [workflowWorkerService], workflowWorkerService);
  }
  assert workflowWorkerService in ownedServiceNames(true);
}

lemma lawTheWorkflowBridgesAreHostServices_ensures(pinnedWorker: bool)
  ensures (lawTheWorkflowBridgesAreHostServices(pinnedWorker) == true)
{
  ProfileOwnedFilter(pinnedWorker);
  var names := ["workflow-device", "workflow-native-digests"];
  forall n | n in names
    ensures !(n in ownedServiceNames(pinnedWorker))
  {
    if pinnedWorker {
      ProofLib.FilterMember((set_x: string) => !((set_x in agentServiceNames)), [workflowWorkerService], n);
    }
  }
  assert ProofLib.Distinct(names);
  ProfileDistinct(names);
}

// spec/agent/plugins/profile.md: a name is planned once when no two positions hold it.
lemma ProfileDistinctFilter(xs: seq<string>)
  ensures distinct(xs) == !((exists x :: x in xs && !((|ProofLib.Filter((y: string) => (y == x), xs)| == 1))))
{
}

lemma ProfileDistinct(xs: seq<string>)
  ensures distinct(xs) == ProofLib.Distinct(xs)
{
  ProfileDistinctFilter(xs);
  if ProofLib.Distinct(xs) {
    forall x | x in xs
      ensures |ProofLib.Filter((y: string) => (y == x), xs)| == 1
    {
      ProofLib.FilterDistinctCountOne((y: string) => (y == x), xs, x);
    }
  } else {
    var i, j :| 0 <= i < j < |xs| && xs[i] == xs[j];
    var x := xs[i];
    ProofLib.FilterTwo((y: string) => (y == x), xs, i, j);
    assert x in xs && |ProofLib.Filter((y: string) => (y == x), xs)| != 1;
  }
}

lemma ProfileLoadFilter(p: agent__host__launch_LaunchPolicy)
  ensures agent__host__launch_policyAdmitted(p) ==> !((exists n :: n in p.pluginsLoad && !((|ProofLib.Filter((m: string) => (m == n), p.pluginsLoad)| == 1))))
{
}

lemma ProfileLoadDistinct(p: agent__host__launch_LaunchPolicy)
  requires agent__host__launch_policyAdmitted(p)
  ensures ProofLib.Distinct(p.pluginsLoad)
{
  ProfileLoadFilter(p);
  var xs := p.pluginsLoad;
  forall i, j | 0 <= i < j < |xs|
    ensures xs[i] != xs[j]
  {
    if xs[i] == xs[j] {
      var x := xs[i];
      ProofLib.FilterTwo((m: string) => (m == x), xs, i, j);
      assert x in xs;
    }
  }
}

// spec/agent/plugins/profile.md: storage, the cloud link and privacy load first, and a load list never names them.
lemma ProfilePlanDistinct(load: seq<string>, privacyOn: bool)
  requires ProofLib.Distinct(load)
  requires !(exists n :: n in load && (n in fixedPlugins))
  ensures distinct(planOrder(load, privacyOn))
{
  var head := [storagePlugin, cloudLinkPlugin] + (if privacyOn then [privacyPlugin] else []);
  var xs := planOrder(load, privacyOn);
  assert xs == head + load;
  forall x | x in head ensures x in fixedPlugins { }
  forall i, j | 0 <= i < j < |xs|
    ensures xs[i] != xs[j]
  {
    if j >= |head| && i < |head| {
      assert xs[j] == load[j - |head|];
      assert xs[j] in load;
      assert xs[i] in head;
    } else if i >= |head| {
      assert xs[i] == load[i - |head|] && xs[j] == load[j - |head|];
    }
  }
  ProfileDistinct(xs);
}

// spec/agent/plugins/profile.md: the worker is offered plain settings only.
lemma ProfileSpawnFilter(s: PluginPlan, offered: seq<ProcessValue>)
  ensures spawnWorker(s, offered).workerEnv == s.workerEnv + ProofLib.Filter((set_x: ProcessValue) => !((set_x in s.workerEnv)), ProofLib.Filter((v: ProcessValue) => v.PlainSetting?, offered))
{
}

// spec/agent/plugins/profile.md: host services never take a name the agent owns.
lemma ProfileOwnedFilter(pinnedWorker: bool)
  ensures ownedServiceNames(pinnedWorker) == (if pinnedWorker then (agentServiceNames + ProofLib.Filter((set_x: string) => !((set_x in agentServiceNames)), [workflowWorkerService])) else agentServiceNames)
{
}
