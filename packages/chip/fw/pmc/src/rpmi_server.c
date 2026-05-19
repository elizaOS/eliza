/*
 * RPMI v1.0 server: parses frames from the SBI MPxy mailbox, dispatches them
 * to the per-service handlers, and returns responses.
 *
 * Frame format (network byte order):
 *   +----------+----------+----------+----------+
 *   | svc_grp  | svc_id   |     token (16b)     |
 *   +----------+----------+---------------------+
 *   |   flags (16b)       |   data_length (16b) |
 *   +---------------------+---------------------+
 *   |                  data[...]                |
 *   +-------------------------------------------+
 */

#include "rpmi.h"

#include <string.h>

static uint16_t rpmi_load_be16(const uint8_t *p)
{
    return (uint16_t)((p[0] << 8) | p[1]);
}

static void rpmi_store_be16(uint8_t *p, uint16_t v)
{
    p[0] = (uint8_t)(v >> 8);
    p[1] = (uint8_t)(v & 0xff);
}

bool rpmi_parse(const uint8_t *buf, size_t len, struct rpmi_frame *out)
{
    if (!buf || !out || len < 8) {
        return false;
    }
    out->service_group_id = buf[0];
    out->service_id       = buf[1];
    out->token            = rpmi_load_be16(&buf[2]);
    out->flags            = rpmi_load_be16(&buf[4]);
    out->data_length      = rpmi_load_be16(&buf[6]);
    if ((size_t)out->data_length + 8u > len ||
        out->data_length > RPMI_MAX_FRAME_BYTES) {
        return false;
    }
    if (out->data_length > 0u) {
        memcpy(out->data, &buf[8], out->data_length);
    }
    return true;
}

size_t rpmi_serialize(const struct rpmi_frame *frame, uint8_t *buf, size_t len)
{
    if (!frame || !buf || len < 8u) {
        return 0;
    }
    if ((size_t)frame->data_length + 8u > len ||
        frame->data_length > RPMI_MAX_FRAME_BYTES) {
        return 0;
    }
    buf[0] = frame->service_group_id;
    buf[1] = frame->service_id;
    rpmi_store_be16(&buf[2], frame->token);
    rpmi_store_be16(&buf[4], frame->flags);
    rpmi_store_be16(&buf[6], frame->data_length);
    if (frame->data_length > 0u) {
        memcpy(&buf[8], frame->data, frame->data_length);
    }
    return (size_t)frame->data_length + 8u;
}

static enum rpmi_status rpmi_voltage_handler(const struct rpmi_frame *req,
                                             struct rpmi_frame *resp)
{
    (void)req;
    (void)resp;
    return RPMI_FAIL_NOT_SUPP;
}

static enum rpmi_status rpmi_clock_handler(const struct rpmi_frame *req,
                                           struct rpmi_frame *resp)
{
    (void)req;
    (void)resp;
    return RPMI_FAIL_NOT_SUPP;
}

static enum rpmi_status rpmi_thermal_handler(const struct rpmi_frame *req,
                                             struct rpmi_frame *resp)
{
    (void)req;
    (void)resp;
    return RPMI_FAIL_NOT_SUPP;
}

enum rpmi_status rpmi_dispatch(const struct rpmi_frame *req,
                               struct rpmi_frame *resp)
{
    if (!req || !resp) {
        return RPMI_FAIL_INV_PARAM;
    }
    resp->service_group_id = req->service_group_id;
    resp->service_id       = req->service_id;
    resp->token            = req->token;
    resp->flags            = 0u;
    resp->data_length      = 0u;

    switch (req->service_group_id) {
    case RPMI_SVC_VOLTAGE:
        return rpmi_voltage_handler(req, resp);
    case RPMI_SVC_CLOCK:
    case RPMI_SVC_PERF:
        return rpmi_clock_handler(req, resp);
    case RPMI_SVC_THERMAL:
        return rpmi_thermal_handler(req, resp);
    default:
        return RPMI_FAIL_NOT_SUPP;
    }
}
