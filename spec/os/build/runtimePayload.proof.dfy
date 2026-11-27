lemma lawAdmittedRuntimesAreLocked_ensures(p: StagedPayload)
  ensures (lawAdmittedRuntimesAreLocked(p) == true)
{
  if payloadVerdict(p).PayloadAdmitted? {
    assert runtimeLayoutValid(p.targets, p.runtimes);
    forall abi | abi in p.targets
      ensures runtimeCount(p.runtimes, abi) == 1
    {
      match abi {
        case Arm64 => assert abi == allAbis[0];
        case X86_64 => assert abi == allAbis[1];
      }
    }
  }
}
