lemma lawAdmittedRuntimesAreLocked_ensures(p: StagedPayload)
  ensures (lawAdmittedRuntimesAreLocked(p) == true)
{
  if payloadVerdict(p).PayloadAdmitted? {
    assert runtimeLayoutValid(p.targets, p.runtimes);
    assert forall candidate :: candidate in p.runtimes ==> runtimeAdmitted(p.lock, candidate);
    forall abi | abi in p.targets ensures runtimeCount(p.runtimes, abi) == 1 {
      assert abi == Abi.Arm64 || abi == Abi.X86_64;
      assert abi in allAbis;
      assert runtimeCount(p.runtimes, abi) == (if abi in p.targets then 1 else 0);
    }
  }
}
