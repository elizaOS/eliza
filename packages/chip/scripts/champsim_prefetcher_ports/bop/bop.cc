#include "bop.h"

#include <algorithm>
#include <iostream>

#include "cache.h"

void bop::prefetcher_initialize()
{
  rr_.fill(0);
  rr_valid_.fill(false);
  scores_.fill(0);
  round_counter_ = 0;
  candidate_ptr_ = 0;
  best_offset_ = 1;
  prefetch_enabled_ = true;
  pref_issued_ = 0;
}

std::size_t bop::rr_index(uint64_t line)
{
  // Simple xor-fold hash into RR_SIZE slots.
  uint64_t h = line;
  h ^= (h >> 16);
  h ^= (h >> 8);
  return static_cast<std::size_t>(h % RR_SIZE);
}

bool bop::rr_lookup(uint64_t line) const
{
  auto idx = rr_index(line);
  return rr_valid_[idx] && rr_[idx] == line;
}

void bop::rr_insert(uint64_t line)
{
  auto idx = rr_index(line);
  rr_[idx] = line;
  rr_valid_[idx] = true;
}

void bop::end_phase()
{
  // Pick the candidate with the highest score; if all scores stayed at
  // BAD_SCORE_THRESHOLD or below, disable prefetching for next phase.
  uint32_t best_score = 0;
  std::size_t best_idx = 0;
  for (std::size_t i = 0; i < CANDIDATES.size(); ++i) {
    if (scores_[i] > best_score) {
      best_score = scores_[i];
      best_idx = i;
    }
  }
  best_offset_ = CANDIDATES[best_idx];
  prefetch_enabled_ = (best_score > BAD_SCORE_THRESHOLD);
  scores_.fill(0);
  round_counter_ = 0;
  candidate_ptr_ = 0;
}

uint32_t bop::prefetcher_cache_operate(champsim::address addr, champsim::address /*ip*/, uint8_t /*cache_hit*/, bool /*useful_prefetch*/,
                                       access_type /*type*/, uint32_t metadata_in)
{
  champsim::block_number cl{addr};
  uint64_t line = cl.to<uint64_t>();

  // Evaluate one candidate offset per access.
  int32_t off = CANDIDATES[candidate_ptr_];
  if (line >= static_cast<uint64_t>(off) && rr_lookup(line - static_cast<uint64_t>(off))) {
    if (scores_[candidate_ptr_] < MAX_SCORE) {
      ++scores_[candidate_ptr_];
    }
  }
  ++candidate_ptr_;
  if (candidate_ptr_ >= CANDIDATES.size()) {
    candidate_ptr_ = 0;
    ++round_counter_;
  }

  bool phase_end = (round_counter_ >= MAX_ROUNDS);
  if (!phase_end) {
    for (auto s : scores_) {
      if (s >= MAX_SCORE) {
        phase_end = true;
        break;
      }
    }
  }
  if (phase_end) {
    end_phase();
  }

  // Issue prefetch using the currently selected best offset, but only when
  // the prefetch lands in the same 4 KiB page (page-crossing prefetches
  // would have to walk a different TLB entry).
  if (prefetch_enabled_) {
    champsim::address pf_addr{cl + best_offset_};
    if (champsim::page_number{pf_addr} == champsim::page_number{addr}) {
      const bool fill_this_level = true;
      if (prefetch_line(pf_addr, fill_this_level, 0)) {
        ++pref_issued_;
      }
    }
  }

  return metadata_in;
}

uint32_t bop::prefetcher_cache_fill(champsim::address addr, long /*set*/, long /*way*/, uint8_t /*prefetch*/, champsim::address /*evicted_addr*/,
                                    uint32_t metadata_in)
{
  // RR insertion on cache fill (paper's "completed prefetch" insertion).
  champsim::block_number cl{addr};
  rr_insert(cl.to<uint64_t>());
  return metadata_in;
}

void bop::prefetcher_cycle_operate() {}

void bop::prefetcher_final_stats()
{
  std::cout << "[BOP] best_offset=" << best_offset_ << " prefetches_issued=" << pref_issued_
            << " prefetch_enabled=" << (prefetch_enabled_ ? 1 : 0) << std::endl;
}
