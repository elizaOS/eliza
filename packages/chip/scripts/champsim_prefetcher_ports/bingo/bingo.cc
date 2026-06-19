#include "bingo.h"

#include <algorithm>
#include <iostream>

#include "cache.h"

void bingo::prefetcher_initialize()
{
  filter_table_ = lru_map<filter_entry>(FILTER_TABLE_SIZE);
  accum_table_ = lru_map<accum_entry>(ACCUM_TABLE_SIZE);
  pht_ = lru_map<pht_entry>(PHT_SIZE);
  pref_issued_ = 0;
}

static inline std::array<bool, bingo::PATTERN_LEN> rotate_pattern(const std::array<bool, bingo::PATTERN_LEN>& p, int n)
{
  std::array<bool, bingo::PATTERN_LEN> out{};
  int len = bingo::PATTERN_LEN;
  n = ((n % len) + len) % len;
  for (int i = 0; i < len; ++i) {
    out[i] = p[(i - n + len) % len];
  }
  return out;
}

void bingo::insert_into_pht(uint64_t pc, uint64_t trigger_offset, const std::array<bool, PATTERN_LEN>& pattern)
{
  // Store rotated-to-canonical pattern keyed by (pc, offset).
  uint64_t key = (pc << 6) ^ (trigger_offset & 0x3F);
  pht_entry e;
  e.pattern = rotate_pattern(pattern, -static_cast<int>(trigger_offset));
  pht_.insert(key, std::move(e));
}

std::array<bool, bingo::PATTERN_LEN> bingo::find_in_pht(uint64_t pc, uint64_t region_offset, bool& any_hit)
{
  any_hit = false;
  uint64_t key = (pc << 6) ^ (region_offset & 0x3F);
  pht_entry* e = pht_.find(key);
  std::array<bool, PATTERN_LEN> out{};
  if (e) {
    any_hit = true;
    out = rotate_pattern(e->pattern, static_cast<int>(region_offset));
  }
  return out;
}

void bingo::evict_region_to_pht(uint64_t /*region_number*/, const accum_entry& e)
{
  insert_into_pht(e.pc, static_cast<uint64_t>(e.trigger_offset), e.pattern);
}

uint32_t bingo::prefetcher_cache_operate(champsim::address addr, champsim::address ip, uint8_t /*cache_hit*/, bool /*useful_prefetch*/,
                                         access_type /*type*/, uint32_t metadata_in)
{
  champsim::block_number cl{addr};
  uint64_t block = cl.to<uint64_t>();
  uint64_t region = block >> (REGION_LOG2 - 6);
  int region_offset = static_cast<int>(block & (PATTERN_LEN - 1));
  uint64_t pc = ip.to<uint64_t>();

  // Case A: region already in accumulation table -> set its bit.
  if (auto* ae = accum_table_.find(region); ae != nullptr) {
    ae->pattern[region_offset] = true;
    return metadata_in;
  }

  // Case B: region in filter table -> second touch promotes to accum table.
  if (auto* fe = filter_table_.find(region); fe != nullptr) {
    if (fe->offset != region_offset) {
      accum_entry ae{};
      ae.pc = fe->pc;
      ae.trigger_offset = fe->offset;
      ae.pattern.fill(false);
      ae.pattern[fe->offset] = true;
      ae.pattern[region_offset] = true;
      // accum_table_.insert evicts a victim entry when at capacity; the
      // evicted region's accumulated pattern trains the PHT (this is how
      // Bingo learns spatial patterns).
      auto victim = accum_table_.insert(region, std::move(ae));
      if (victim) {
        evict_region_to_pht(victim->first, victim->second);
      }
      filter_table_.erase(region);
    }
    return metadata_in;
  }

  // Case C: first touch -> insert in filter table and probe PHT.
  filter_table_.insert(region, filter_entry{pc, region_offset});
  bool hit = false;
  auto pattern = find_in_pht(pc, static_cast<uint64_t>(region_offset), hit);
  if (!hit) {
    return metadata_in;
  }

  // Stream prefetches from the predicted pattern; skip the trigger block
  // itself and keep prefetches in the same page.
  for (int d = 1; d < PATTERN_LEN; ++d) {
    for (int sgn = +1; sgn >= -1; sgn -= 2) {
      int pf_off = region_offset + sgn * d;
      if (pf_off < 0 || pf_off >= PATTERN_LEN) {
        continue;
      }
      if (!pattern[pf_off]) {
        continue;
      }
      int64_t delta = static_cast<int64_t>(pf_off - region_offset);
      champsim::address pf_addr{cl + delta};
      if (champsim::page_number{pf_addr} != champsim::page_number{addr}) {
        continue;
      }
      if (prefetch_line(pf_addr, true, 0)) {
        ++pref_issued_;
      }
    }
  }
  return metadata_in;
}

uint32_t bingo::prefetcher_cache_fill(champsim::address /*addr*/, long /*set*/, long /*way*/, uint8_t /*prefetch*/, champsim::address /*evicted_addr*/,
                                      uint32_t metadata_in)
{
  return metadata_in;
}

void bingo::prefetcher_final_stats() { std::cout << "[Bingo] prefetches_issued=" << pref_issued_ << std::endl; }
