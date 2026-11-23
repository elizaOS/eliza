// spec/cloud/deployment.md, "The entitlement's services claim names the enabled capabilities in one fixed order"; spec/cloud/deployment.md, "A scheduled tick runs each sweep whose period ends within the tick"

lemma lawServicesListEachEnabledCapabilityOnce_ensures(offered: seq<Capability>, c: Capability)
  ensures (lawServicesListEachEnabledCapabilityOnce(offered, c) == true)
{
  var keep := (c: Capability) => (c in offered);
  var same := (x: Capability) => (x == c);
  var listed := ProofLib.Filter(keep, capabilityOrder);
  var identity := (x: Capability) => x;
  assert enabledServices(offered) == listed;
  assert c in capabilityOrder;
  ProofLib.FilterMember(keep, capabilityOrder, c);
  if c in offered {
    assert ProofLib.DistinctBy(capabilityOrder, identity);
    ProofLib.FilterKeepsDistinctBy(keep, capabilityOrder, identity);
    assert ProofLib.Distinct(listed);
    ProofLib.FilterDistinctCountOne(same, listed, c);
  } else {
    forall i | 0 <= i < |listed|
      ensures !same(listed[i])
    {
      assert listed[i] in listed;
    }
    ProofLib.FilterNone(same, listed);
  }
  assert |ProofLib.Filter(same, listed)| == (if c in offered then 1 else 0);
}

lemma SweepRemainder(at: int, period: int)
  requires period > 0
  ensures remainder_cloud__deployment(at, period) == (if at < 0 then -(MathAbs(at) % period) else MathAbs(at) % period)
  ensures -period < remainder_cloud__deployment(at, period) < period
{
  var magnitude := MathAbs(at);
  assert JSFloorDiv(magnitude, period) == magnitude / period;
  assert magnitude == period * (magnitude / period) + magnitude % period;
}

lemma lawAWholeMinuteSweepRunsAtItsPeriodOnly_ensures(scheduledAt: int, everyMs: int)
  ensures (lawAWholeMinuteSweepRunsAtItsPeriodOnly(scheduledAt, everyMs) == true)
{
  if everyMs >= sweepTick && remainder_cloud__deployment(everyMs, sweepTick) == 0 && remainder_cloud__deployment(scheduledAt, sweepTick) == 0 {
    var tick := sweepTick;
    var magnitude := MathAbs(scheduledAt);
    SweepRemainder(everyMs, tick);
    SweepRemainder(scheduledAt, tick);
    SweepRemainder(scheduledAt, everyMs);
    assert magnitude == tick * (magnitude / tick);
    assert everyMs == tick * (everyMs / tick);
    var remainder := magnitude % everyMs;
    assert magnitude == everyMs * (magnitude / everyMs) + remainder;
    var blocks := magnitude / tick - (everyMs / tick) * (magnitude / everyMs);
    assert remainder == tick * blocks;
    var signed := remainder_cloud__deployment(scheduledAt, everyMs);
    var elapsed := if signed < 0 then signed + everyMs else signed;
    var elapsedBlocks := if signed < 0 then everyMs / tick - blocks else blocks;
    assert elapsed == tick * elapsedBlocks;
    assert 0 <= elapsed < everyMs;
    if elapsedBlocks != 0 {
      assert elapsedBlocks >= 1;
      assert elapsed >= tick;
    }
    assert (elapsed == 0) == (signed == 0);
    assert sweepDue(scheduledAt, everyMs) == (elapsed < tick);
  }
}

lemma lawAShortSweepRunsAtEveryTick_ensures(scheduledAt: int, everyMs: int)
  ensures (lawAShortSweepRunsAtEveryTick(scheduledAt, everyMs) == true)
{
  if 0 < everyMs <= sweepTick {
    SweepRemainder(scheduledAt, everyMs);
    var signed := remainder_cloud__deployment(scheduledAt, everyMs);
    var elapsed := if signed < 0 then signed + everyMs else signed;
    assert 0 <= elapsed < everyMs;
    assert sweepDue(scheduledAt, everyMs);
  }
}
