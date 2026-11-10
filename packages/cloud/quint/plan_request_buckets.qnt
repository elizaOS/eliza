// Local paired token buckets in plan-request-limiter.ts. One clock tick adds
// integer quarter-token units. Each request consumes four units from both.
// Two resolved identity keys have separate, pre-existing buckets at time 4.
module plan_request_buckets {
  const BurstCapacity: int
  const SustainedCapacity: int
  const BurstRate: int
  const SustainedRate: int
  type Bucket = {
    burst: int, sustained: int, at: int, high: int, spent: int
  }
  type Reply = { refused: bool, burst: int, sustained: int, boundary: int, retryAt: int }
  type State = { now: int, buckets: int -> Bucket, reply: Reply }
  var s: State
  pure val identities = Set(0, 1)
  pure def maximum(a: int, b: int): int = if (a >= b) a else b
  pure def minimum(a: int, b: int): int = if (a <= b) a else b

  action init = s' = {
    now: 4,
    reply: { refused: false, burst: 0, sustained: 0, boundary: 0, retryAt: 0 },
    buckets: identities.mapBy(_ => {
      burst: BurstCapacity, sustained: SustainedCapacity,
      at: 4, high: 4, spent: 0
    })
  }

  action clock(value: int): bool = all {
    value >= 0, value <= 8, s' = s.with("now", value)
  }

  pure def waitTicks(tokens: int, rate: int): int =
    if (tokens >= 4) 0 else if (rate == 1) 4 - tokens else 1

  action consume(key: int, retainBoundary: bool, correctReply: bool): bool = {
    val previous = s.buckets.get(key)
    val elapsed = maximum(0, s.now - previous.at)
    val burst = minimum(BurstCapacity, previous.burst + elapsed * BurstRate)
    val sustained = minimum(SustainedCapacity, previous.sustained + elapsed * SustainedRate)
    val admitted = burst >= 4 and sustained >= 4
    val high = maximum(previous.high, s.now)
    val boundary = if (retainBoundary) maximum(previous.at, s.now) else s.now
    val wait = maximum(waitTicks(burst, BurstRate), waitTicks(sustained, SustainedRate))
    s' = s.with("reply", {
      refused: not(admitted), burst: burst, sustained: sustained, boundary: boundary,
      retryAt: (if (correctReply) boundary else s.now) + wait
    }).with("buckets", s.buckets.set(key, {
      burst: burst - (if (admitted) 4 else 0),
      sustained: sustained - (if (admitted) 4 else 0),
      at: boundary,
      high: high, spent: previous.spent + (if (admitted) 1 else 0)
    }))
  }

  action step = {
    nondet key = identities.oneOf()
    nondet value = 0.to(8).oneOf()
    any { clock(value), consume(key, true, true) }
  }

  val boundedTokens = identities.forall(key => {
    val b = s.buckets.get(key)
    all {
      b.burst >= 0, b.burst <= BurstCapacity,
      b.sustained >= 0, b.sustained <= SustainedCapacity,
      b.spent >= 0
    }
  })
  val refillBoundaryNeverRetreats = identities.forall(key => {
    val b = s.buckets.get(key)
    b.at == b.high and b.high >= 4 and b.high <= 8
  })
  val admittedWithinClockBudget = identities.forall(key => {
    val b = s.buckets.get(key)
    all {
      b.spent * 4 <= BurstCapacity + (b.high - 4) * BurstRate,
      b.spent * 4 <= SustainedCapacity + (b.high - 4) * SustainedRate
    }
  })
  val retryIsUsable = not(s.reply.refused) or all {
    s.reply.retryAt >= s.reply.boundary,
    s.reply.burst + (s.reply.retryAt - s.reply.boundary) * BurstRate >= 4,
    s.reply.sustained + (s.reply.retryAt - s.reply.boundary) * SustainedRate >= 4
  }
  val safety = boundedTokens and refillBoundaryNeverRetreats and admittedWithinClockBudget and retryIsUsable

  run rollbackDoesNotRefillTest = init.then(consume(0, true, true))
    .then(clock(0)).then(consume(0, true, true))
    .then(clock(4)).then(consume(0, true, true))
    .expect(safety and s.buckets.get(0).spent == 1)

  run fractionalRefillSurvivesRollbackTest = init.then(consume(0, true, true))
    .then(clock(5)).then(consume(0, true, true))
    .then(clock(0)).then(consume(0, true, true))
    .then(clock(6)).then(consume(0, true, true))
    .then(clock(8)).then(consume(0, true, true))
    .expect(safety and s.buckets.get(0).spent == 2)

  run identityBucketsAreIndependentTest = init.then(consume(0, true, true))
    .then(consume(1, true, true))
    .expect(safety and s.buckets.get(0).spent == 1 and s.buckets.get(1).spent == 1)

  run oldRetryDelayNegativeWitnessTest = init.then(consume(0, true, true))
    .then(clock(0)).then(consume(0, true, false))
    .expect(not(retryIsUsable))

  // The previous timestamp update reuses the interval when time returns to 4.
  run oldTimestampNegativeWitnessTest = init.then(consume(0, false, true))
    .then(clock(0)).then(consume(0, false, true))
    .then(clock(4)).then(consume(0, false, true))
    .expect(not(admittedWithinClockBudget))
}

module plan_request_burst_limited {
  import plan_request_buckets(
    BurstCapacity = 4, SustainedCapacity = 12,
    BurstRate = 1, SustainedRate = 4
  ).*
}

module plan_request_sustained_limited {
  import plan_request_buckets(
    BurstCapacity = 12, SustainedCapacity = 4,
    BurstRate = 4, SustainedRate = 1
  ).*
}
