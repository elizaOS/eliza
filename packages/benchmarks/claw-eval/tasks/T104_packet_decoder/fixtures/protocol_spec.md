# ClawNet Protocol Specification v1.3

## Overview

ClawNet is a binary protocol for sensor network communication.
Each message is framed as a packet with a fixed header, optional extensions,
a variable-length payload, and an error-detection trailer.

Packets in a capture stream are aligned to 4-byte boundaries.

## Packet Structure

```
+--------+--------+--------+--------+--------+--------+--------+--------+--------+--------+--------+
|       Magic (4 bytes)             |Version |  Type  | Flags  |   Sequence (2B)  | Payload Len(2B) |
+--------+--------+--------+--------+--------+--------+--------+--------+--------+--------+--------+
|   [Extension Header — present only if flags bit 7 is set]  (4 bytes)                              |
+--------+--------+--------+--------+--------+--------+--------+--------+--------+--------+--------+
|                           Payload (variable length)                                               |
+--------+--------+--------+--------+--------+--------+--------+--------+--------+--------+--------+
|         CRC (2 bytes)             |  [Padding to 4-byte boundary]                                 |
+--------+--------+--------+--------+--------+--------+--------+--------+--------+--------+--------+
```

## Header (11 bytes, big-endian)

| Field          | Offset | Size   | Encoding    | Description                |
|----------------|--------|--------|-------------|----------------------------|
| Magic          | 0      | 4 bytes| ASCII       | Protocol identifier "CLAW" |
| Version        | 4      | 1 byte | uint8       | Protocol version (0x13)    |
| Type           | 5      | 1 byte | uint8       | Message type               |
| Flags          | 6      | 1 byte | bitfield    | Message flags              |
| Sequence       | 7      | 2 bytes| uint16 BE   | Sequence number            |
| Payload Length | 9      | 2 bytes| uint16 BE   | Payload size in bytes      |

### Flags Bitfield

| Bit | Name      | Description                              |
|-----|-----------|------------------------------------------|
| 0   | COMPRESS  | Payload is compressed (informational)     |
| 1   | ENCRYPT   | Payload is encrypted (informational)      |
| 2-6 | Reserved  | Must be zero                              |
| 7   | EXT_HDR   | Extension header follows standard header  |

When bit 7 is set, an additional 4-byte extension header immediately follows
the standard 11-byte header. The extension header is included in the CRC
calculation along with the standard header and payload.

### Message Types

| Value | Name      | Description              |
|-------|-----------|--------------------------|
| 0x01  | HANDSHAKE | Connection initialization |
| 0x02  | DATA      | Sensor data message      |
| 0x03  | HEARTBEAT | Keep-alive signal        |
| 0x04  | CLOSE     | Connection termination   |
| 0x05  | CONFIG    | Configuration update     |
| 0x06  | ERROR     | Error report             |

## Payload Formats

All multi-byte integer fields within payloads use little-endian byte order.

### HANDSHAKE (0x01)

| Field         | Size    | Type        | Description                    |
|---------------|---------|-------------|--------------------------------|
| hostname_len  | 1 byte  | uint8       | Length of hostname string       |
| hostname      | N bytes | ASCII string| Device hostname                |
| firmware_ver  | 2 bytes | uint16 LE   | Packed firmware version         |

The firmware version packs major and minor into a single uint16.

### DATA (0x02)

| Field      | Size    | Type        | Description                    |
|------------|---------|-------------|--------------------------------|
| sensor_id  | 2 bytes | uint16 LE   | Sensor identifier              |
| value      | 4 bytes | float32 LE  | IEEE 754 single-precision      |
| timestamp  | 4 bytes | uint32 LE   | Unix timestamp (seconds)       |
| msg_len    | 1 byte  | uint8       | Length of status message        |
| message    | N bytes | ASCII string| Human-readable status          |

### HEARTBEAT (0x03)

| Field          | Size    | Type      | Description              |
|----------------|---------|-----------|--------------------------|
| uptime_seconds | 4 bytes | uint32 LE | Device uptime in seconds |

### CLOSE (0x04)

| Field       | Size    | Type        | Description              |
|-------------|---------|-------------|--------------------------|
| reason_code | 2 bytes | uint16 LE   | Reason for closing        |
| msg_len     | 1 byte  | uint8       | Length of reason message   |
| message     | N bytes | ASCII string| Human-readable reason     |

### CONFIG (0x05)

Configuration messages carry key-value string pairs.

### ERROR (0x06)

Error reports include a numeric code, severity level, and description.

## CRC Checksum

Each packet includes a 16-bit CRC for error detection, stored in big-endian
byte order after the payload. The CRC uses polynomial 0x8005 and is computed
over the concatenation of the header (including extension header if present)
and payload bytes.

Some packets in the capture may have corrupted CRC values.

## Output Format

Your decoder should produce a JSONL file (one JSON object per line) at
`/workspace/decoded.jsonl`. Each line represents one packet.

Common fields for all packet types:
- `type`: string — message type name
- `seq`: integer — sequence number
- `flags`: integer — raw flags byte value
- `crc_valid`: boolean — whether CRC check passed

Include type-specific payload fields as appropriate.

For DATA packets, round float values to 2 decimal places.
For HANDSHAKE packets, format firmware version as "major.minor".
