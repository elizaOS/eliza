/** Records only loader-owned trampoline generations and their kernel retirement. */
#ifndef ELIZA_LEDGER_RETIREMENT_H
#define ELIZA_LEDGER_RETIREMENT_H
struct retirement_control { unsigned long long owner_thread, armed; };
struct retirement_counters {
 unsigned long long allocated, retired, allocation_failure, image_collision;
 unsigned long long history_failure, lookup_failure, delete_failure, duplicate_retirement;
};
struct retirement_generation { unsigned long long allocated_ns, retired_ns; };
#endif
