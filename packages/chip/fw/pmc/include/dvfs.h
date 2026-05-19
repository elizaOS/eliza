/*
 * DVFS table loader interface.
 *
 * Tables are statically compiled into the PMC firmware from the YAML files
 * in docs/pd/dvfs-tables/. A build step (TBD) emits a corresponding C array
 * per corner; until then, the placeholder TT table in
 * fw/pmc/src/dvfs_arbiter.c is used.
 */

#ifndef ELIZA_PMC_DVFS_H
#define ELIZA_PMC_DVFS_H

#include "pmc.h"

const struct pmc_dvfs_table *pmc_dvfs_table_for_corner(enum pmc_corner corner);

#endif /* ELIZA_PMC_DVFS_H */
