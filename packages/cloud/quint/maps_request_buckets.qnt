// One fixed Maps allowance window; only successful admissions persist the paired buckets.
module maps_request_buckets {
  const BurstCapacity: int
  const SustainedCapacity: int
  const BurstRate: int
  const SustainedRate: int
  type Bucket = { burst: int, sustained: int, at: int, high: int, spent: int }
  type Reply = { refused: bool, burst: int, sustained: int, boundary: int, retryAt: int }
  type State = { now: int, bucket: Bucket, reply: Reply }
  var s: State
  pure def maximum(a: int, b: int): int = if (a >= b) a else b
  pure def minimum(a: int, b: int): int = if (a <= b) a else b
  pure def waitTicks(tokens: int, rate: int): int =
    if (tokens >= 4) 0 else if (rate == 1) 4 - tokens else 1
  action init = s' = {
    now: 4,
    bucket: { burst: BurstCapacity, sustained: SustainedCapacity, at: 4, high: 4, spent: 0 },
    reply: { refused: false, burst: 0, sustained: 0, boundary: 0, retryAt: 0 }
  }
  action clock(value: int): bool = all {
    value >= 0, value <= 8, s' = s.with("now", value)
  }
  action consume(retainBoundary: bool, correctReply: bool): bool = {
    val previous = s.bucket
    val elapsed = maximum(0, s.now - previous.at)
    val burst = minimum(BurstCapacity, previous.burst + elapsed * BurstRate)
    val sustained = minimum(SustainedCapacity, previous.sustained + elapsed * SustainedRate)
    val admitted = burst >= 4 and sustained >= 4
    val boundary = if (retainBoundary) maximum(previous.at, s.now) else s.now
    val wait = maximum(waitTicks(burst, BurstRate), waitTicks(sustained, SustainedRate))
    s' = s.with("reply", {
      refused: not(admitted), burst: burst, sustained: sustained, boundary: boundary,
      retryAt: (if (correctReply) boundary else s.now) + wait
    }).with("bucket", if (admitted) {
      burst: burst - 4, sustained: sustained - 4, at: boundary,
      high: maximum(previous.high, s.now), spent: previous.spent + 1
    } else previous)
  }
  action step = {
    nondet value = 0.to(8).oneOf()
    any { clock(value), consume(true, true) }
  }
  val safety = all {
    s.bucket.burst >= 0 and s.bucket.burst <= BurstCapacity,
    s.bucket.sustained >= 0 and s.bucket.sustained <= SustainedCapacity,
    s.bucket.at == s.bucket.high,
    s.bucket.spent * 4 <= BurstCapacity + (s.bucket.high - 4) * BurstRate,
    s.bucket.spent * 4 <= SustainedCapacity + (s.bucket.high - 4) * SustainedRate,
    not(s.reply.refused) or all {
      s.reply.retryAt >= s.reply.boundary,
      s.reply.burst + (s.reply.retryAt - s.reply.boundary) * BurstRate >= 4,
      s.reply.sustained + (s.reply.retryAt - s.reply.boundary) * SustainedRate >= 4
    }
  }
  run rollbackDoesNotMintTest = init.then(consume(true, true)).then(clock(0))
    .then(consume(true, true)).then(clock(4)).then(consume(true, true))
    .expect(safety and s.bucket.spent == 2 and s.reply.refused)
  run retryIncludesRetainedBoundaryTest = init.then(consume(true, true))
    .then(consume(true, true)).then(clock(0)).then(consume(true, true))
    .expect(safety and s.reply.refused and s.reply.retryAt == 8)
  run actualNewTimeRefillsTest = init.then(consume(true, true)).then(consume(true, true))
    .then(clock(8)).then(consume(true, true)).expect(safety and s.bucket.spent == 3)
  run oldTimestampWitnessTest = init.then(consume(false, true)).then(clock(0))
    .then(consume(false, true)).then(clock(4)).then(consume(false, true)).expect(not(safety))
  run oldRetryWitnessTest = init.then(consume(true, true)).then(consume(true, true))
    .then(clock(0)).then(consume(true, false)).expect(not(safety))
}
module maps_burst_limited {
  import maps_request_buckets(
    BurstCapacity = 8, SustainedCapacity = 16, BurstRate = 1, SustainedRate = 4
  ).*
}
module maps_sustained_limited {
  import maps_request_buckets(
    BurstCapacity = 16, SustainedCapacity = 8, BurstRate = 4, SustainedRate = 1
  ).*
}
