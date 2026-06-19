/*
 * RPMI v1.0 frame format (subset used by PMC firmware).
 *
 * Source: RISC-V RPMI v1.0 specification.
 * This header captures only the fields required by the AON Ibex PMC RPMI
 * server. Service ID assignments follow the standard service-class map.
 */

#ifndef ELIZA_PMC_RPMI_H
#define ELIZA_PMC_RPMI_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define RPMI_MAX_FRAME_BYTES   256u
#define RPMI_VERSION_MAJOR     1u
#define RPMI_VERSION_MINOR     0u

enum rpmi_service_class {
    RPMI_SVC_BASE      = 0x00,
    RPMI_SVC_SYSTEM    = 0x01,
    RPMI_SVC_CPU       = 0x02,
    RPMI_SVC_VOLTAGE   = 0x03,
    RPMI_SVC_CLOCK     = 0x04,
    RPMI_SVC_PERF      = 0x05,
    RPMI_SVC_THERMAL   = 0x06,
    RPMI_SVC_RAS       = 0x07,
    RPMI_SVC_VENDOR    = 0x80
};

enum rpmi_status {
    RPMI_OK              = 0,
    RPMI_FAIL_GENERIC    = 1,
    RPMI_FAIL_NOT_SUPP   = 2,
    RPMI_FAIL_INV_PARAM  = 3,
    RPMI_FAIL_DENIED     = 4,
    RPMI_FAIL_NOT_FOUND  = 5,
    RPMI_FAIL_OUT_OF_RNG = 6,
    RPMI_FAIL_OUT_OF_RES = 7,
    RPMI_FAIL_HW_FAULT   = 8
};

struct rpmi_frame {
    uint8_t  service_group_id;
    uint8_t  service_id;
    uint16_t token;
    uint16_t flags;
    uint16_t data_length;
    uint8_t  data[RPMI_MAX_FRAME_BYTES];
};

bool rpmi_parse(const uint8_t *buf, size_t len, struct rpmi_frame *out);
size_t rpmi_serialize(const struct rpmi_frame *frame, uint8_t *buf, size_t len);
enum rpmi_status rpmi_dispatch(const struct rpmi_frame *req, struct rpmi_frame *resp);

#endif /* ELIZA_PMC_RPMI_H */
