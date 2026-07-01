#include "berti.h"

#include <algorithm>
#include <iostream>
#include <unordered_map>

#include "cache.h"

void berti::prefetcher_initialize()
{
  ip_table_.assign(IP_TABLE_ENTRIES, ip_entry{});
  pref_issued_ = 0;
  pref_burst_ = 0;
}

std::pair<int, int> berti::vote_best_delta(const ip_entry& e) const
{
  std::unordered_map<int, int> votes;
  votes.reserve(e.delta_count);
  for (std::size_t i = 0; i < e.delta_count; ++i) {
    int d = e.deltas[i];
    if (d == 0) {
      continue;
    }
    ++votes[d];
  }
  int best_d = 0;
  int best_v = 0;
  for (auto& [d, v] : votes) {
    if (v > best_v) {
      best_v = v;
      best_d = d;
    }
  }
  return {best_d, best_v};
}

uint32_t berti::prefetcher_cache_operate(champsim::address addr, champsim::address ip, uint8_t /*cache_hit*/, bool /*useful_prefetch*/,
                                         access_type /*type*/, uint32_t metadata_in)
{
  champsim::block_number cl{addr};
  champsim::page_number page{addr};
  uint64_t ip_raw = ip.to<uint64_t>();
  std::size_t idx = static_cast<std::size_t>(ip_raw & (IP_TABLE_ENTRIES - 1));
  uint64_t ip_tag = ip_raw >> IP_TABLE_INDEX_BITS;

  int page_offset = static_cast<int>(cl.to<uint64_t>() & (PAGE_BLOCKS - 1));
  uint64_t page_raw = page.to<uint64_t>();

  auto& e = ip_table_[idx];
  if (!e.valid || e.ip_tag != ip_tag) {
    e = ip_entry{};
    e.valid = true;
    e.ip_tag = ip_tag;
    e.last_offset = page_offset;
    e.last_page = page_raw;
    return metadata_in;
  }

  // Same-page delta only (Berti treats page-crossings as a reset event).
  int delta = 0;
  if (e.last_page == page_raw && e.last_offset >= 0) {
    delta = page_offset - e.last_offset;
  } else {
    e.last_page = page_raw;
    e.last_offset = page_offset;
    return metadata_in;
  }
  e.last_offset = page_offset;

  if (delta != 0) {
    e.deltas[e.delta_head] = delta;
    e.delta_head = (e.delta_head + 1) % HISTORY_PER_IP;
    if (e.delta_count < HISTORY_PER_IP) {
      ++e.delta_count;
    }
  }

  auto [best_delta, votes] = vote_best_delta(e);
  if (best_delta == 0 || votes < CONFIDENCE_THRESHOLD) {
    return metadata_in;
  }

  // High-confidence delta: issue prefetches with throttled degree.
  int degree = std::min(MAX_DEGREE, votes / 2);
  for (int i = 1; i <= degree; ++i) {
    int64_t d = static_cast<int64_t>(best_delta) * i;
    champsim::address pf_addr{cl + d};
    if (champsim::page_number{pf_addr} != page) {
      break;
    }
    if (prefetch_line(pf_addr, true, 0)) {
      ++pref_issued_;
    }
  }

  // Burst mode: when votes are saturated, issue MAX_BURST consecutive
  // strides starting from the current line.
  if (votes >= static_cast<int>(HISTORY_PER_IP)) {
    for (int i = 1; i <= MAX_BURST; ++i) {
      int64_t d = static_cast<int64_t>(best_delta) * (MAX_DEGREE + i);
      champsim::address pf_addr{cl + d};
      if (champsim::page_number{pf_addr} != page) {
        break;
      }
      if (prefetch_line(pf_addr, false, 0)) {
        ++pref_burst_;
      }
    }
  }

  return metadata_in;
}

uint32_t berti::prefetcher_cache_fill(champsim::address /*addr*/, long /*set*/, long /*way*/, uint8_t /*prefetch*/, champsim::address /*evicted_addr*/,
                                      uint32_t metadata_in)
{
  return metadata_in;
}

void berti::prefetcher_final_stats() { std::cout << "[Berti] issued=" << pref_issued_ << " burst=" << pref_burst_ << std::endl; }
