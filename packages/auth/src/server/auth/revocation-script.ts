/** Internal Redis primitive for atomically advancing a revocation line. */
export const MONOTONIC_REVOCATION_SCRIPT = `
local markerKey = KEYS[1]
local latestKey = KEYS[2]
local issuedBefore = tonumber(ARGV[1])
local ttlMs = tonumber(ARGV[2])

local function setWithTtl(key, value, effectiveTtlMs)
  if effectiveTtlMs == -1 then
    redis.call("SET", key, value)
  else
    redis.call("SET", key, value, "PX", effectiveTtlMs)
  end
end

local existingRaw = redis.call("GET", latestKey)
local existingTtlMs = redis.call("PTTL", latestKey)
local existing = tonumber(existingRaw)
if existingRaw == false or existing == nil then
  setWithTtl(markerKey, "1", ttlMs)
  setWithTtl(latestKey, ARGV[1], ttlMs)
  return issuedBefore
end

-- A stale revocation request must not shorten either the current revocation
-- line or its event marker. A persistent line remains persistent.
local effectiveTtlMs = ttlMs
if existingTtlMs == -1 then
  effectiveTtlMs = -1
elseif existingTtlMs > effectiveTtlMs then
  effectiveTtlMs = existingTtlMs
end
setWithTtl(markerKey, "1", effectiveTtlMs)

if issuedBefore > existing then
  setWithTtl(latestKey, ARGV[1], effectiveTtlMs)
  return issuedBefore
end
if effectiveTtlMs > existingTtlMs then
  redis.call("PEXPIRE", latestKey, effectiveTtlMs)
end
return existing
`;
